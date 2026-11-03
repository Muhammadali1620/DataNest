// Changing a SQLite file on a server through the `sqlite3` program (V13.36), for a server with no
// Python 3: the statements that are refused before they are sent, the answers read back, and a
// real `sqlite3` on this machine behind it. The tests that need the program are skipped where
// there is none.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { RemoteFileSpec } from '../../../src/services/remote-snapshots';
import {
  bigIntegersAsText,
  CLI_COMMAND,
  CLI_SCRIPT,
  cliRefusal,
  errorAnswer,
  fileAddress,
  openRemoteWriter,
  SqliteCliWriter,
} from '../../../src/services/remote-sqlite-cli';
import type { SqliteWriter } from '../../../src/services/remote-sqlite-writer';
import type { ExecChannel, ExecEnd, ExecOpener } from '../../../src/services/shell-types';
import { RecordingLogger } from '../../helpers/fakes';
import { HAS_SQLITE_CLI, LocalCliOpener } from '../../helpers/python-exec';

const SPEC: RemoteFileSpec = {
  hops: [],
  checkHostKey: () => Promise.resolve(true),
  timeoutMs: 1000,
};
const logger = new RecordingLogger();

describe('the command', () => {
  it('is a constant: nothing the user typed is in it', () => {
    expect(CLI_COMMAND).toBe(`sh -c '${CLI_SCRIPT}'`);
    expect(CLI_SCRIPT).toContain('read -r f');
    expect(CLI_SCRIPT).toContain('exec sqlite3');
    expect(CLI_COMMAND).not.toMatch(/srv|\.db/u);
  });

  it('spells the file as an address that opens it for reading and writing only', () => {
    expect(fileAddress('/srv/app.db')).toBe('file:/srv/app.db?mode=rw');
    expect(fileAddress('/srv/a b#c?d%e.db')).toBe('file:/srv/a%20b%23c%3Fd%25e.db?mode=rw');
    expect(fileAddress('/srv/é€.db')).toContain('%C3%A9%E2%82%AC');
    expect(fileAddress('/srv/new\nline.db')).not.toContain('\n');
  });
});

describe('what is refused before it is sent', () => {
  it('lets a single complete statement through, comments and all', () => {
    expect(cliRefusal('INSERT INTO t VALUES (1)')).toBeUndefined();
    expect(cliRefusal('-- note\nSELECT 1;')).toBeUndefined();
    expect(cliRefusal('SELECT \'a;b\', "c;d" /* ; */')).toBeUndefined();
    expect(cliRefusal('SELECT\n  1,\n  2 -- trailing')).toBeUndefined();
  });

  it('refuses nothing, several statements, and what is not complete', () => {
    expect(cliRefusal('   ')).toBe('empty');
    expect(cliRefusal('SELECT 1; SELECT 2')).toBe('several');
    expect(cliRefusal("SELECT 'open")).toBe('incomplete');
    expect(cliRefusal('SELECT 1 /* open')).toBe('incomplete');
    expect(cliRefusal('SELECT "open')).toBe('incomplete');
  });

  it('refuses a line the program would take for one of its commands', () => {
    expect(cliRefusal('.shell id')).toBe('dot');
    expect(cliRefusal('-- hi\n.shell id')).toBe('dot');
    expect(cliRefusal('SELECT 1\n  .quit')).toBe('dot');
    expect(cliRefusal('#comment')).toBe('dot');
    expect(cliRefusal("SELECT 'a\n.shell id'")).toBe('dot');
  });

  it('does not refuse a dot inside a line', () => {
    expect(cliRefusal('SELECT t.a, 1.5 FROM main.t')).toBeUndefined();
  });
});

describe('bigIntegersAsText (V13.39)', () => {
  it('writes a whole number beyond 2^53 in the form of the Python helper, and nothing else', () => {
    const text = bigIntegersAsText(
      '[{"a":9223372036854775807,"b":-9223372036854775808,"c":9007199254740991,"d":9007199254740993}]',
    );
    expect(JSON.parse(text)).toEqual([
      {
        a: { i: '9223372036854775807' },
        b: { i: '-9223372036854775808' },
        c: 9007199254740991,
        d: { i: '9007199254740993' },
      },
    ]);
  });

  it('leaves small numbers, floats and exponents as they are', () => {
    const json = '[{"x":0,"y":-5,"z":1.499999999999999781e+300,"w":123456789012345678.5,"v":1e22}]';
    expect(bigIntegersAsText(json)).toBe(json);
  });

  it('does not look inside a string, a key or an escaped quote', () => {
    const json =
      '[{"9223372036854775807":"id 9223372036854775807 \\" 9223372036854775807","n":null}]';
    expect(bigIntegersAsText(json)).toBe(json);
    expect(JSON.parse(bigIntegersAsText(json))).toEqual([
      { '9223372036854775807': 'id 9223372036854775807 " 9223372036854775807', n: null },
    ]);
  });

  it('handles an empty answer, true, false and nested arrays', () => {
    expect(bigIntegersAsText('')).toBe('');
    expect(bigIntegersAsText('[{"a":[1,[9223372036854775806],true,false]}]')).toBe(
      '[{"a":[1,[{"i":"9223372036854775806"}],true,false]}]',
    );
  });
});

describe('errorAnswer', () => {
  it('takes the message and the code out of what the program prints', () => {
    expect(errorAnswer('Runtime error near line 4: UNIQUE constraint failed: t.name (19)')).toEqual(
      {
        ok: false,
        message: 'UNIQUE constraint failed: t.name',
        code: 19,
        kind: 'IntegrityError',
      },
    );
    expect(
      errorAnswer('Parse error near line 1: near "SELEC": syntax error\n  SELEC 1;\n  ^'),
    ).toEqual({ ok: false, message: 'near "SELEC": syntax error' });
    expect(errorAnswer('Error: database is locked (5)')).toEqual({
      ok: false,
      message: 'database is locked',
      code: 5,
    });
  });

  it('keeps text it does not know as it is', () => {
    expect(errorAnswer('something odd')).toEqual({ ok: false, message: 'something odd' });
  });
});

/** A server where every command ends at once, like one without the program. */
class MissingProgramOpener implements ExecOpener {
  commands: string[] = [];
  openExec(_spec: RemoteFileSpec, command: string): Promise<ExecChannel> {
    this.commands.push(command);
    const end: ExecEnd = { reason: 'exit', code: 127 };
    return Promise.resolve({
      closed: Promise.resolve(end),
      onData: (listener) => {
        queueMicrotask(() => {
          listener(Buffer.from('sh: 1: sqlite3: not found\n'), true);
        });
      },
      write: () => undefined,
      close: () => undefined,
    });
  }
}

describe('choosing the way', () => {
  it('says plainly when the server has neither Python 3 nor the program', async () => {
    const opener = new MissingProgramOpener();
    await expect(openRemoteWriter(opener, SPEC, '/srv/a.db', { logger })).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/Python 3.*sqlite3 program.*neither/u) as unknown,
    });
    expect(opener.commands).toHaveLength(2);
    expect(opener.commands[0]).toContain('python3');
    expect(opener.commands[1]).toBe(CLI_COMMAND);
  });
});

describe.skipIf(!HAS_SQLITE_CLI)('with a real sqlite3 program', () => {
  let dir: string;
  let file: string;
  let opener: LocalCliOpener;
  const writers: SqliteWriter[] = [];

  function seed(sql: string): void {
    const db = new DatabaseSync(file);
    db.exec(sql);
    db.close();
  }

  function rowsOf(sql: string): unknown[] {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  }

  async function open(
    options: { busyTimeoutMs?: number; init?: string[]; path?: string } = {},
  ): Promise<SqliteCliWriter> {
    const writer = await SqliteCliWriter.open(opener, SPEC, options.path ?? file, {
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
      ...(options.init === undefined ? {} : { init: options.init }),
      logger,
    });
    writers.push(writer);
    return writer;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-cli-'));
    file = join(dir, 'app.db');
    opener = new LocalCliOpener();
    seed('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, n REAL)');
  });

  afterEach(async () => {
    for (const writer of writers.splice(0)) {
      await writer.close().catch(() => undefined);
    }
    opener.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('statements', () => {
    it('changes the file and says how many rows', async () => {
      const writer = await open();
      expect(await writer.run("INSERT INTO t (name) VALUES ('a'), ('b'), ('c')")).toEqual({
        affectedRows: 3,
        inTransaction: false,
      });
      expect(await writer.run("UPDATE t SET n = 1.5 WHERE name <> 'a'")).toMatchObject({
        affectedRows: 2,
      });
      expect(await writer.run("DELETE FROM t WHERE name = 'c'")).toMatchObject({ affectedRows: 1 });
      expect(rowsOf('SELECT name, n FROM t ORDER BY id')).toEqual([
        { name: 'a', n: null },
        { name: 'b', n: 1.5 },
      ]);
    });

    it('says nothing about rows for a statement that changes the structure', async () => {
      const writer = await open();
      const outcome = await writer.run('CREATE TABLE u (id INTEGER)');
      expect(outcome).toEqual({ inTransaction: false });
      expect(rowsOf("SELECT name FROM sqlite_master WHERE name = 'u'")).toHaveLength(1);
    });

    it('gives the rows of a statement that returns some', async () => {
      const writer = await open();
      const outcome = await writer.run("INSERT INTO t (name) VALUES ('x') RETURNING id, name");
      expect(outcome.columns).toEqual([{ name: 'id' }, { name: 'name' }]);
      expect(outcome.rows).toEqual([[1, 'x']]);
      expect(outcome.affectedRows).toBe(1);
    });

    it('gives no columns for a result without rows: the program does not say them', async () => {
      const writer = await open();
      const outcome = await writer.run('SELECT * FROM t');
      expect(outcome.columns).toBeUndefined();
      expect(outcome.rows).toBeUndefined();
    });

    it('keeps a whole number beyond 2^53 whole (V13.39)', async () => {
      const writer = await open();
      await writer.run('CREATE TABLE big (id INTEGER, note TEXT)');
      await writer.run(
        "INSERT INTO big VALUES (9223372036854775807, 'id 9223372036854775807'), (-9223372036854775808, 'low'), (9007199254740993, 'edge'), (42, 'small')",
      );
      const outcome = await writer.run('SELECT id, note FROM big ORDER BY rowid');
      expect(outcome.rows).toEqual([
        [{ kind: 'bigint', text: '9223372036854775807' }, 'id 9223372036854775807'],
        [{ kind: 'bigint', text: '-9223372036854775808' }, 'low'],
        [{ kind: 'bigint', text: '9007199254740993' }, 'edge'],
        [42, 'small'],
      ]);
      const returned = await writer.run(
        'INSERT INTO big VALUES (9223372036854775806, NULL) RETURNING id',
      );
      expect(returned.rows).toEqual([[{ kind: 'bigint', text: '9223372036854775806' }]]);
    });

    it('does not report a stale count for a statement that changes no rows', async () => {
      const writer = await open();
      await writer.run("INSERT INTO t (name) VALUES ('a')");
      const read = await writer.run('SELECT 1 AS one');
      expect(read.affectedRows).toBeUndefined();
      expect(read.rows).toEqual([[1]]);
    });

    it('carries text, quotes, new lines and non-Latin letters through unchanged', async () => {
      const writer = await open();
      const name = 'it\'s "quoted"\nsecond line; $(id) `x` \\ é€ 日本 😀';
      await writer.run(`INSERT INTO t (name) VALUES ('${name.replace(/'/gu, "''")}')`);
      expect(rowsOf('SELECT name FROM t')).toEqual([{ name }]);
      const back = await writer.run('SELECT name FROM t');
      expect(back.rows).toEqual([[name]]);
    });

    it('carries a long value', async () => {
      const writer = await open();
      const long = 'x'.repeat(200_000);
      await writer.run(`INSERT INTO t (name) VALUES ('${long}')`);
      expect(rowsOf('SELECT length(name) AS n FROM t')).toEqual([{ n: 200_000 }]);
    });

    it('takes a line of the statement that merely looks like the end of the answer', async () => {
      const writer = await open();
      await writer.run("INSERT INTO t (name) VALUES ('E-abc\nM-def\nB-123')");
      expect(rowsOf('SELECT name FROM t')).toEqual([{ name: 'E-abc\nM-def\nB-123' }]);
    });

    it('runs the settings of the connection first', async () => {
      seed('CREATE TABLE child (p INTEGER REFERENCES t(id))');
      const writer = await open({ init: ['PRAGMA foreign_keys = ON'] });
      await expect(writer.run('INSERT INTO child VALUES (99)')).rejects.toMatchObject({
        code: 'constraint',
      });
    });
  });

  describe('what is refused', () => {
    it('refuses a statement with a line that starts with a dot, and runs on', async () => {
      const writer = await open();
      await expect(writer.run('.shell touch /tmp/never')).rejects.toMatchObject({
        code: 'unsupported',
      });
      await expect(writer.run('-- x\n.shell touch /tmp/never')).rejects.toMatchObject({
        code: 'unsupported',
      });
      expect(existsSync('/tmp/never')).toBe(false);
      expect(await writer.run("INSERT INTO t (name) VALUES ('ok')")).toMatchObject({
        affectedRows: 1,
      });
    });

    it('refuses several statements and an open quote, without sending them', async () => {
      const writer = await open();
      await expect(
        writer.run("INSERT INTO t (name) VALUES ('1'); INSERT INTO t (name) VALUES ('2')"),
      ).rejects.toMatchObject({ code: 'unsupported' });
      await expect(writer.run("INSERT INTO t (name) VALUES ('open")).rejects.toMatchObject({
        code: 'syntax',
      });
      await expect(writer.run('  ')).rejects.toMatchObject({ code: 'syntax' });
      expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
      expect(await writer.run("INSERT INTO t (name) VALUES ('fine')")).toMatchObject({
        affectedRows: 1,
      });
    });
  });

  describe('errors', () => {
    it('names a constraint, a syntax error and a missing table', async () => {
      const writer = await open();
      await writer.run("INSERT INTO t (name) VALUES ('a')");
      await expect(writer.run("INSERT INTO t (name) VALUES ('a')")).rejects.toMatchObject({
        code: 'constraint',
        message: expect.stringContaining('UNIQUE') as unknown,
      });
      await expect(writer.run('SELEC 1')).rejects.toMatchObject({ code: 'syntax' });
      await expect(writer.run('SELECT * FROM nope')).rejects.toMatchObject({ code: 'not-found' });
      // Still alive, and still the same file.
      expect(await writer.run('SELECT count(*) AS n FROM t')).toMatchObject({ rows: [[1]] });
    });

    it('waits for a program that holds the file, then says it is busy', async () => {
      const writer = await open({ busyTimeoutMs: 300 });
      const other = new DatabaseSync(file);
      other.exec('BEGIN EXCLUSIVE');
      try {
        const started = Date.now();
        await expect(writer.run("INSERT INTO t (name) VALUES ('x')")).rejects.toMatchObject({
          code: 'busy',
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      } finally {
        other.exec('ROLLBACK');
        other.close();
      }
      expect(await writer.run("INSERT INTO t (name) VALUES ('x')")).toMatchObject({
        affectedRows: 1,
      });
    });

    it('does not make a database where there is no file', async () => {
      const missing = join(dir, 'missing.db');
      await expect(open({ path: missing })).rejects.toMatchObject({ code: 'permission-denied' });
      expect(existsSync(missing)).toBe(false);
    });

    it('does not make a database where the folder is not there', async () => {
      await expect(open({ path: join(dir, 'no', 'such', 'dir.db') })).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('opens a file whose name has characters of an address', async () => {
      const odd = join(dir, 'a b#c%e.db');
      const db = new DatabaseSync(odd);
      db.exec('CREATE TABLE odd (id INTEGER)');
      db.close();
      const writer = await open({ path: odd });
      expect(await writer.run('INSERT INTO odd VALUES (1)')).toMatchObject({ affectedRows: 1 });
    });
  });

  describe('transactions', () => {
    it('follows BEGIN, COMMIT and ROLLBACK, and keeps the change away until the commit', async () => {
      const writer = await open();
      expect(writer.inTransaction).toBe(false);
      expect(await writer.run('BEGIN')).toMatchObject({ inTransaction: true });
      await writer.run("INSERT INTO t (name) VALUES ('a')");
      expect(writer.inTransaction).toBe(true);
      expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
      // A read through the same connection sees the change of the open transaction.
      expect((await writer.run('SELECT count(*) AS n FROM t')).rows).toEqual([[1]]);
      expect(await writer.run('COMMIT')).toMatchObject({ inTransaction: false });
      expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }]);

      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (name) VALUES ('b')");
      expect(await writer.run('ROLLBACK')).toMatchObject({ inTransaction: false });
      expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }]);
    });

    it('keeps the transaction open after a statement of it failed', async () => {
      const writer = await open();
      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (name) VALUES ('a')");
      await expect(writer.run("INSERT INTO t (name) VALUES ('a')")).rejects.toMatchObject({
        code: 'constraint',
      });
      expect(writer.inTransaction).toBe(true);
      await writer.run('COMMIT');
      expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }]);
    });

    it('asks the file after a savepoint, which may or may not have opened a transaction', async () => {
      const writer = await open();
      expect(await writer.run('SAVEPOINT s')).toMatchObject({ inTransaction: true });
      await writer.run("INSERT INTO t (name) VALUES ('a')");
      expect(await writer.run('RELEASE s')).toMatchObject({ inTransaction: false });
      expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }]);

      await writer.run('BEGIN');
      expect(await writer.run('SAVEPOINT inner')).toMatchObject({ inTransaction: true });
      expect(await writer.run('RELEASE inner')).toMatchObject({ inTransaction: true });
      await writer.run('ROLLBACK');
      expect(writer.inTransaction).toBe(false);
    });

    it('does not leave a transaction behind when it only asks the file', async () => {
      const writer = await open();
      await writer.run('SAVEPOINT s');
      await writer.run('ROLLBACK');
      // The probe began and undid a transaction of its own; the file is free for another program.
      const other = new DatabaseSync(file);
      other.exec("INSERT INTO t (name) VALUES ('other')");
      other.close();
      expect(writer.inTransaction).toBe(false);
    });

    it('undoes what is not committed when the link is dropped', async () => {
      const writer = await open();
      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (name) VALUES ('lost')");
      writer.abort();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
      expect(writer.alive).toBe(false);
      await expect(writer.run('SELECT 1')).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('closing', () => {
    it('ends the program, and says so for a later statement', async () => {
      const writer = await open();
      await writer.close();
      expect(writer.alive).toBe(false);
      await expect(writer.run('SELECT 1')).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('can be closed twice', async () => {
      const writer = await open();
      await writer.close();
      await expect(writer.close()).resolves.toBeUndefined();
    });
  });

  describe('as the fallback of the Python helper', () => {
    it('is used when the server has no Python 3', async () => {
      const writer = await openRemoteWriter(opener, SPEC, file, { logger });
      writers.push(writer);
      expect(opener.commands).toHaveLength(2);
      expect(opener.commands[0]).toContain('python3');
      expect(opener.commands[1]).toBe(CLI_COMMAND);
      expect(await writer.run("INSERT INTO t (name) VALUES ('z')")).toMatchObject({
        affectedRows: 1,
      });
      expect(rowsOf('SELECT name FROM t')).toEqual([{ name: 'z' }]);
    });

    it('gives the error of the file, not of the choice, when the file cannot be opened', async () => {
      await expect(
        openRemoteWriter(opener, SPEC, join(dir, 'missing.db'), { logger }),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });
});

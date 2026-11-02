// The helper that changes a SQLite file on a server (V13.33), run with a real Python 3 and a real
// SQLite: statements, transactions, values of every kind, the ways a change can fail, and a
// helper that goes away. Skipped where there is no `python3`.

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { RemoteFileSpec } from '../../../src/services/remote-snapshots';
import {
  cellOf,
  RemoteSqliteWriter,
  requestLine,
} from '../../../src/services/remote-sqlite-writer';
import { helperCommand, helperProgram } from '../../../src/services/remote-sqlite-script';
import type { ExecChannel, ExecEnd, ExecOpener } from '../../../src/services/shell-types';
import { RecordingLogger } from '../../helpers/fakes';
import { HAS_PYTHON, LocalPythonOpener } from '../../helpers/python-exec';

const SPEC: RemoteFileSpec = {
  hops: [],
  checkHostKey: () => Promise.resolve(true),
  timeoutMs: 1000,
};
const logger = new RecordingLogger();

let dir: string;
let file: string;
let opener: LocalPythonOpener;
const writers: RemoteSqliteWriter[] = [];

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
): Promise<RemoteSqliteWriter> {
  const writer = await RemoteSqliteWriter.open(opener, SPEC, options.path ?? file, {
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.init === undefined ? {} : { init: options.init }),
    logger,
  });
  writers.push(writer);
  return writer;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-writer-'));
  file = join(dir, 'app.db');
  opener = new LocalPythonOpener();
  seed('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, data BLOB, n REAL)');
});

afterEach(async () => {
  for (const writer of writers.splice(0)) {
    await writer.close().catch(() => undefined);
  }
  opener.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('the command line', () => {
  it('carries only base64 letters inside its quotes, and nothing the user typed', () => {
    const command = helperCommand();
    expect(command.startsWith("python3 -u -c '")).toBe(true);
    const inside = /"([^"]*)"/.exec(command)?.[1] ?? '';
    expect(inside).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(helperProgram()).not.toContain("'");
    expect(command).toBe(`python3 -u -c '${helperProgram()}'`);
    expect(helperProgram()).toContain('b64decode');
  });
});

describe('requestLine', () => {
  it('is one line of plain ASCII, whatever the statement holds', () => {
    const line = requestLine({ id: 1, sql: "INSERT INTO t VALUES ('é','日本','😀')\n" });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    // eslint-disable-next-line no-control-regex
    expect(line).toMatch(/^[\x00-\x7f]*$/);
    expect(JSON.parse(line)).toMatchObject({ sql: "INSERT INTO t VALUES ('é','日本','😀')\n" });
  });
});

describe('cellOf', () => {
  it('turns what the helper sends into cells of the grid', () => {
    expect(cellOf(null)).toBeNull();
    expect(cellOf(undefined)).toBeNull();
    expect(cellOf('text')).toBe('text');
    expect(cellOf(true)).toBe(true);
    expect(cellOf(1.5)).toBe(1.5);
    expect(cellOf(Number.NaN)).toBeNull();
    expect(cellOf({ i: '9223372036854775807' })).toEqual({
      kind: 'bigint',
      text: '9223372036854775807',
    });
    expect(cellOf({ b: Buffer.from([0, 255, 16]).toString('base64') })).toMatchObject({
      kind: 'binary',
      size: 3,
      preview: '00ff10',
    });
    expect(cellOf({ other: 1 })).toEqual({ kind: 'json', text: '{"other":1}' });
  });
});

describe.skipIf(!HAS_PYTHON)('RemoteSqliteWriter with a real SQLite', () => {
  it('changes the file and reports how many rows', async () => {
    const writer = await open();
    const outcome = await writer.run("INSERT INTO t (name) VALUES ('a'), ('b')");
    expect(outcome).toEqual({ affectedRows: 2, inTransaction: false });
    expect(rowsOf('SELECT name FROM t ORDER BY id')).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect((await writer.run("UPDATE t SET name = 'z' WHERE name = 'a'")).affectedRows).toBe(1);
    expect((await writer.run('DELETE FROM t')).affectedRows).toBe(2);
    expect(rowsOf('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
  });

  it('runs DDL and says nothing about rows', async () => {
    const writer = await open();
    const outcome = await writer.run('CREATE TABLE extra (id INTEGER)');
    expect(outcome.affectedRows).toBeUndefined();
    expect(outcome.columns).toBeUndefined();
    expect(rowsOf("SELECT name FROM sqlite_master WHERE name = 'extra'")).toHaveLength(1);
  });

  it('returns the rows of a statement that has some', async () => {
    const writer = await open();
    const outcome = await writer.run(
      "INSERT INTO t (name, n) VALUES ('r', 2.5) RETURNING id, name, n",
    );
    expect(outcome.columns).toEqual([{ name: 'id' }, { name: 'name' }, { name: 'n' }]);
    expect(outcome.rows).toEqual([[1, 'r', 2.5]]);
    expect(outcome.affectedRows).toBe(1);
  });

  it('keeps text of every script safe: quotes, newlines, Unicode, emoji', async () => {
    const writer = await open();
    const awkward = [
      "it's",
      'say "hi"',
      'line\nbreak\ttab',
      'back\\slash',
      'ключ 日本語 😀 é',
      '$(rm -rf /)',
      '`x`',
    ];
    for (const [index, text] of awkward.entries()) {
      const quoted = `'${text.replaceAll("'", "''")}'`;
      await writer.run(`INSERT INTO t (id, name) VALUES (${index + 1}, ${quoted})`);
    }
    const stored = rowsOf('SELECT name FROM t ORDER BY id').map(
      (row) => (row as { name: string }).name,
    );
    expect(stored).toEqual(awkward);
    const back = await writer.run('SELECT name FROM t ORDER BY id');
    expect(back.rows?.map((row) => row[0])).toEqual(awkward);
  });

  it('carries a large value in one statement', async () => {
    const writer = await open();
    const big = 'ж'.repeat(300_000);
    await writer.run(`INSERT INTO t (id, name) VALUES (1, '${big}')`);
    expect(rowsOf('SELECT length(name) AS n FROM t')).toEqual([{ n: 300_000 }]);
  });

  it('hands back NULL, floats, big integers and bytes as cells', async () => {
    const writer = await open();
    const outcome = await writer.run(
      "SELECT NULL, 1.25, 9223372036854775807, 42, x'00ff10', 'text', 1e999, -1e999",
    );
    const row = outcome.rows?.[0] ?? [];
    expect(row[0]).toBeNull();
    expect(row[1]).toBe(1.25);
    expect(row[2]).toEqual({ kind: 'bigint', text: '9223372036854775807' });
    expect(row[3]).toBe(42);
    expect(row[4]).toMatchObject({ kind: 'binary', size: 3, preview: '00ff10' });
    expect(row[5]).toBe('text');
    // Infinity cannot travel as JSON: it arrives as an empty cell, not as a broken line.
    expect(row[6]).toBeNull();
    expect(row[7]).toBeNull();
  });

  it('writes bytes of its own', async () => {
    const writer = await open();
    await writer.run("INSERT INTO t (id, data) VALUES (1, x'deadbeef')");
    expect(rowsOf('SELECT hex(data) AS h FROM t')).toEqual([{ h: 'DEADBEEF' }]);
  });

  it('keeps statements in the order they were asked for, even when asked together', async () => {
    const writer = await open();
    const results = await Promise.all([
      writer.run("INSERT INTO t (id, name) VALUES (1, 'one')"),
      writer.run("UPDATE t SET name = 'two' WHERE id = 1"),
      writer.run('SELECT name FROM t'),
    ]);
    expect(results[2].rows).toEqual([['two']]);
  });

  describe('transactions', () => {
    it('spans statements: nothing is visible to others until COMMIT', async () => {
      const writer = await open();
      expect(writer.inTransaction).toBe(false);
      expect((await writer.run('BEGIN')).inTransaction).toBe(true);
      expect(writer.inTransaction).toBe(true);
      await writer.run("INSERT INTO t (id, name) VALUES (1, 'x')");
      expect(writer.inTransaction).toBe(true);
      expect(rowsOf('SELECT * FROM t')).toEqual([]);
      expect((await writer.run('COMMIT')).inTransaction).toBe(false);
      expect(writer.inTransaction).toBe(false);
      expect(rowsOf('SELECT name FROM t')).toEqual([{ name: 'x' }]);
    });

    it('takes everything back on ROLLBACK', async () => {
      const writer = await open();
      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (id, name) VALUES (1, 'x')");
      await writer.run("INSERT INTO t (id, name) VALUES (2, 'y')");
      await writer.run('ROLLBACK');
      expect(rowsOf('SELECT * FROM t')).toEqual([]);
      expect(writer.inTransaction).toBe(false);
    });

    it('keeps the transaction open after a statement failed', async () => {
      const writer = await open();
      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (id, name) VALUES (1, 'x')");
      await expect(writer.run("INSERT INTO t (id, name) VALUES (2, 'x')")).rejects.toMatchObject({
        code: 'constraint',
      });
      expect(writer.inTransaction).toBe(true);
      await writer.run('COMMIT');
      expect(rowsOf('SELECT id FROM t')).toEqual([{ id: 1 }]);
    });

    it('works with savepoints', async () => {
      const writer = await open();
      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (id, name) VALUES (1, 'a')");
      await writer.run('SAVEPOINT s');
      await writer.run("INSERT INTO t (id, name) VALUES (2, 'b')");
      await writer.run('ROLLBACK TO s');
      await writer.run('COMMIT');
      expect(rowsOf('SELECT id FROM t')).toEqual([{ id: 1 }]);
    });

    it('undoes a transaction that was open when the helper is closed', async () => {
      const writer = await open();
      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (id, name) VALUES (1, 'x')");
      await writer.close();
      expect(rowsOf('SELECT * FROM t')).toEqual([]);
    });
  });

  describe('failures', () => {
    it('says a constraint was broken', async () => {
      const writer = await open();
      await writer.run("INSERT INTO t (name) VALUES ('a')");
      const error = await writer.run("INSERT INTO t (name) VALUES ('a')").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({ code: 'constraint' });
      expect((error as DbError).message).toMatch(/UNIQUE/i);
      // The helper survives a failed statement.
      expect(writer.alive).toBe(true);
      expect((await writer.run("INSERT INTO t (name) VALUES ('b')")).affectedRows).toBe(1);
    });

    it('says a statement is wrong', async () => {
      const writer = await open();
      await expect(writer.run('INSERT INTO nowhere VALUES (1)')).rejects.toMatchObject({
        code: 'not-found',
      });
      await expect(writer.run('INSERT garbage')).rejects.toMatchObject({ code: 'syntax' });
      await expect(writer.run('CREATE TABLE t (id)')).rejects.toMatchObject({ code: 'constraint' });
    });

    it('refuses two statements in one, so a script is never half run', async () => {
      const writer = await open();
      await expect(
        writer.run("INSERT INTO t (name) VALUES ('a'); INSERT INTO t (name) VALUES ('b')"),
      ).rejects.toBeInstanceOf(DbError);
      expect(rowsOf('SELECT * FROM t')).toEqual([]);
    });

    it('waits for a program that holds the file, then says it is busy', async () => {
      const writer = await open({ busyTimeoutMs: 300 });
      const other = new DatabaseSync(file);
      other.exec('BEGIN IMMEDIATE');
      try {
        const started = Date.now();
        const error = await writer
          .run("INSERT INTO t (name) VALUES ('late')")
          .catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'busy' });
        expect((error as DbError).message).toMatch(/in use by another program/);
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      } finally {
        other.exec('ROLLBACK');
        other.close();
      }
      // Once the other program lets go, the same helper goes on.
      expect((await writer.run("INSERT INTO t (name) VALUES ('late')")).affectedRows).toBe(1);
    });

    it('goes on when the other program lets go within the wait', async () => {
      const writer = await open({ busyTimeoutMs: 5000 });
      const other = new DatabaseSync(file);
      other.exec('BEGIN IMMEDIATE');
      setTimeout(() => {
        other.exec('COMMIT');
        other.close();
      }, 300);
      expect((await writer.run("INSERT INTO t (name) VALUES ('waited')")).affectedRows).toBe(1);
    });

    it('does not create a file that is not there', async () => {
      const error = await open({ path: join(dir, 'missing.db') }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'permission-denied' });
      expect((error as DbError).message).toMatch(/may not exist/);
      expect(rowsOf('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'says the user may not change a file that is read-only to it',
      async () => {
        chmodSync(file, 0o444);
        try {
          const writer = await open();
          const error = await writer
            .run("INSERT INTO t (name) VALUES ('x')")
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ code: 'permission-denied' });
          expect((error as DbError).message).toMatch(/may not change the file/);
        } finally {
          chmodSync(file, 0o644);
        }
      },
    );

    it('reports a path with characters that need escaping in a URI', async () => {
      // `?` and `*` are not allowed in a Windows file name.
      const odd = join(dir, process.platform === 'win32' ? 'a b#c%e.db' : 'a b#c?d%e.db');
      new DatabaseSync(odd).close();
      const writer = await open({ path: odd });
      await writer.run('CREATE TABLE odd (id INTEGER)');
      const db = new DatabaseSync(odd, { readOnly: true });
      expect(db.prepare('SELECT count(*) AS n FROM sqlite_master').get()).toEqual({ n: 1 });
      db.close();
    });
  });

  it('applies the settings it is opened with', async () => {
    seed(
      'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (p INTEGER REFERENCES parent(id))',
    );
    const plain = await open();
    expect((await plain.run('INSERT INTO child VALUES (99)')).affectedRows).toBe(1);
    await plain.run('DELETE FROM child');
    await plain.close();
    const strict = await open({ init: ['PRAGMA foreign_keys = ON'] });
    await expect(strict.run('INSERT INTO child VALUES (99)')).rejects.toMatchObject({
      code: 'constraint',
    });
  });

  it('stops a statement that runs long by dropping the link', async () => {
    const writer = await open();
    const long = writer.run(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    writer.abort();
    await expect(long).rejects.toMatchObject({ code: 'cancelled' });
    expect(writer.alive).toBe(false);
    await expect(writer.run('SELECT 1')).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('can be closed twice', async () => {
    const writer = await open();
    await writer.close();
    await writer.close();
    expect(writer.alive).toBe(false);
  });

  it('fails every waiting statement when the helper dies', async () => {
    const writer = await open();
    const first = writer.run(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
    );
    const second = writer.run('SELECT 1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const child of opener.children) {
      child.kill('SIGKILL');
    }
    const errors = await Promise.all([
      first.catch((e: unknown) => e),
      second.catch((e: unknown) => e),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(DbError);
    }
    expect(writer.alive).toBe(false);
  });
});

/** A channel that plays a script: what the "server" says, and how it ends. */
function scripted(play: (channel: Scripted) => void): ExecOpener {
  return {
    openExec: () => {
      const channel = new Scripted();
      queueMicrotask(() => {
        play(channel);
      });
      return Promise.resolve(channel);
    },
  };
}

class Scripted implements ExecChannel {
  readonly written: string[] = [];
  private readonly listeners: ((chunk: Buffer, error: boolean) => void)[] = [];
  private finish!: (end: ExecEnd) => void;
  readonly closed = new Promise<ExecEnd>((resolve) => {
    this.finish = resolve;
  });

  private early: { text: string; error: boolean }[] = [];

  onData(listener: (chunk: Buffer, error: boolean) => void): void {
    this.listeners.push(listener);
    for (const item of this.early.splice(0)) {
      listener(Buffer.from(item.text), item.error);
    }
  }

  /** Called with each request line, so a script can answer it. */
  onWrite: ((data: string) => void) | undefined;

  write(data: string): void {
    this.written.push(data);
    this.onWrite?.(data);
  }

  close(): void {
    this.finish({ reason: 'closed' });
  }

  say(text: string, error = false): void {
    if (this.listeners.length === 0) {
      this.early.push({ text, error });
      return;
    }
    for (const listener of this.listeners) {
      listener(Buffer.from(text), error);
    }
  }

  end(end: ExecEnd): void {
    this.finish(end);
  }
}

describe('a server without Python', () => {
  it('says what is missing when the shell cannot find python3', async () => {
    const opener2 = scripted((channel) => {
      channel.say('sh: 1: python3: not found\n', true);
      channel.end({ reason: 'exit', code: 127 });
    });
    const error = await RemoteSqliteWriter.open(opener2, SPEC, '/x.db', { logger }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'unsupported' });
    expect((error as DbError).message).toMatch(/needs Python 3/);
  });

  it('says what went wrong when the helper stops for another reason', async () => {
    const opener2 = scripted((channel) => {
      channel.say('Traceback: boom\n', true);
      channel.end({ reason: 'exit', code: 1 });
    });
    const error = await RemoteSqliteWriter.open(opener2, SPEC, '/x.db', { logger }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'connection-failed' });
    expect((error as DbError).message).toMatch(/exit code 1.*boom/s);
  });

  it('says the link was lost when it drops', async () => {
    const opener2 = scripted((channel) => {
      channel.end({ reason: 'dropped' });
    });
    const error = await RemoteSqliteWriter.open(opener2, SPEC, '/x.db', { logger }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'connection-failed' });
    expect((error as DbError).message).toMatch(/lost/);
  });
});

describe('what the server prints besides answers', () => {
  it('ignores a greeting of the login shell and answers split across chunks', async () => {
    let channelRef: Scripted | undefined;
    const opener2 = scripted((channel) => {
      channelRef = channel;
      channel.say('Welcome to the server\nLast login: yesterday\n');
      channel.onWrite = () => {
        const reply = `${JSON.stringify({ id: 1, ok: true, version: '3.45', python: '3.12' })}\n`;
        channel.say(reply.slice(0, 10));
        channel.say(reply.slice(10));
      };
    });
    const writer = await RemoteSqliteWriter.open(opener2, SPEC, '/x.db', { logger });
    expect(writer.alive).toBe(true);
    expect(channelRef?.written[0]).toContain('"op":"open"');
    expect(channelRef?.written[0]).toContain('"path":"/x.db"');
    channelRef?.end({ reason: 'exit', code: 0 });
  });

  it('turns an answer without a result code into an internal error', async () => {
    const opener2 = scripted((channel) => {
      channel.onWrite = () => {
        channel.say(`${JSON.stringify({ id: 1, ok: false, message: 'strange' })}\n`);
      };
    });
    await expect(RemoteSqliteWriter.open(opener2, SPEC, '/x.db', { logger })).rejects.toMatchObject(
      {
        code: 'internal',
        message: 'strange',
      },
    );
  });
});

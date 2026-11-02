// The session on a SQLite file on a server that may be changed there (V13.33): which statements
// go to the server and which to the copy, when the copy is made again, and what happens to the
// helper. The copy, the driver and the helper are all fakes here; the helper itself is tested
// with a real SQLite in remote-sqlite-writer.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ExecuteEvent, MetadataReader, Session } from '../../../src/drivers/driver';
import type { SnapshotLease } from '../../../src/services/remote-snapshots';
import {
  RemoteWritableSession,
  runsOnServer,
  SERVER_ROW_CAP,
  type RemoteSqliteDeps,
} from '../../../src/services/remote-sqlite-session';
import type { SqliteWriter, WriteOutcome } from '../../../src/services/remote-sqlite-writer';

async function collect(events: AsyncIterable<ExecuteEvent>): Promise<ExecuteEvent[]> {
  const all: ExecuteEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

class FakeLocal implements Session {
  readonly executed: string[] = [];
  closed = false;
  cancelled = 0;
  readonly calls: string[] = [];
  readonly metadata: MetadataReader;

  constructor(readonly path: string) {
    const calls = this.calls;
    this.metadata = {
      listTables: (scope: unknown) => {
        calls.push(`listTables@${path}`);
        return Promise.resolve([{ name: String(scope) }]);
      },
    } as unknown as MetadataReader;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *execute(sql: string): AsyncGenerator<ExecuteEvent> {
    this.executed.push(sql);
    yield { kind: 'columns', columns: [{ name: 'c' }] };
    yield { kind: 'rows', rows: [[this.path]] };
    yield { kind: 'done' };
  }

  cancel(): Promise<void> {
    this.cancelled += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeWriter {
  readonly ran: string[] = [];
  alive = true;
  inTransaction = false;
  aborted = false;
  closedCount = 0;
  /** What the next statement does; undefined: succeeds with a plain outcome. */
  next: ((sql: string) => Promise<WriteOutcome>) | undefined;

  run(sql: string): Promise<WriteOutcome> {
    this.ran.push(sql);
    if (this.next !== undefined) {
      return this.next(sql);
    }
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('BEGIN')) {
      this.inTransaction = true;
    } else if (upper.startsWith('COMMIT') || /^ROLLBACK(?! TO)/.test(upper)) {
      this.inTransaction = false;
    }
    return Promise.resolve({ affectedRows: 1, inTransaction: this.inTransaction });
  }

  abort(): void {
    this.aborted = true;
    this.alive = false;
  }

  close(): Promise<void> {
    this.closedCount += 1;
    this.alive = false;
    return Promise.resolve();
  }
}

interface Rig {
  readonly deps: RemoteSqliteDeps;
  readonly locals: FakeLocal[];
  readonly writers: FakeWriter[];
  readonly leases: { path: string; released: number }[];
  generation: number;
  invalidated: number;
  failWriter: Error | undefined;
  session: RemoteWritableSession;
}

function writerOf(r: Rig, index = 0): FakeWriter {
  const writer = r.writers[index];
  if (writer === undefined) {
    throw new Error('The helper was not started');
  }
  return writer;
}

function rig(): Rig {
  const locals: FakeLocal[] = [];
  const writers: FakeWriter[] = [];
  const leases: { path: string; released: number }[] = [];
  const lease = (path: string): SnapshotLease => {
    const record = { path, released: 0 };
    leases.push(record);
    return {
      path,
      bytes: 10,
      release: () => {
        record.released += 1;
        return Promise.resolve();
      },
    };
  };
  const state = { generation: 0, invalidated: 0, failWriter: undefined as Error | undefined };
  const deps: RemoteSqliteDeps = {
    openLocal: (path) => {
      const local = new FakeLocal(path);
      locals.push(local);
      return Promise.resolve(local);
    },
    acquireCopy: () => Promise.resolve(lease(`/copy-${leases.length + 1}/data.db`)),
    generation: () => state.generation,
    invalidate: () => {
      state.generation += 1;
      state.invalidated += 1;
    },
    openWriter: () => {
      if (state.failWriter !== undefined) {
        return Promise.reject(state.failWriter);
      }
      const writer = new FakeWriter();
      writers.push(writer);
      return Promise.resolve(writer as unknown as SqliteWriter);
    },
  };
  const first = new FakeLocal('/copy-0/data.db');
  locals.push(first);
  const session = new RemoteWritableSession(deps, {
    local: first,
    lease: lease('/copy-0/data.db'),
    generation: 0,
  });
  return {
    deps,
    locals,
    writers,
    leases,
    get generation() {
      return state.generation;
    },
    get invalidated() {
      return state.invalidated;
    },
    get failWriter() {
      return state.failWriter;
    },
    set failWriter(value) {
      state.failWriter = value;
    },
    session,
  };
}

describe('runsOnServer', () => {
  it('keeps reads on the copy', () => {
    for (const sql of [
      'SELECT * FROM t',
      'select 1',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT 1',
      'PRAGMA table_info(t)',
      '-- note\nSELECT 1',
    ]) {
      expect(runsOnServer(sql), sql).toBe(false);
    }
  });

  it('sends changes and the end of transactions to the server', () => {
    for (const sql of [
      "INSERT INTO t VALUES ('a')",
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'CREATE TABLE x (id)',
      'DROP TABLE x',
      'ALTER TABLE t ADD COLUMN c',
      'REPLACE INTO t VALUES (1)',
      'PRAGMA foreign_keys = ON',
      'VACUUM',
      'BEGIN',
      'BEGIN IMMEDIATE',
      'COMMIT',
      'END',
      'ROLLBACK',
      'SAVEPOINT s',
      'RELEASE s',
      'ROLLBACK TO s',
      'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    ]) {
      expect(runsOnServer(sql), sql).toBe(true);
    }
  });
});

describe('RemoteWritableSession', () => {
  let r: Rig;

  beforeEach(() => {
    r = rig();
  });

  it('reads from the copy and does not start the helper', async () => {
    const events = await collect(r.session.execute('SELECT 1'));
    expect(events.map((event) => event.kind)).toEqual(['columns', 'rows', 'done']);
    expect(r.locals[0]?.executed).toEqual(['SELECT 1']);
    expect(r.writers).toHaveLength(0);
  });

  it('sends a change to the server and answers with what the server said', async () => {
    const events = await collect(r.session.execute("INSERT INTO t VALUES ('a')"));
    expect(events).toEqual([{ kind: 'done', affectedRows: 1 }]);
    expect(r.writers).toHaveLength(1);
    expect(r.writers[0]?.ran).toEqual(["INSERT INTO t VALUES ('a')"]);
    expect(r.locals[0]?.executed).toEqual([]);
  });

  it('answers a statement that returns rows with columns and rows', async () => {
    await collect(r.session.execute('INSERT INTO t VALUES (1)'));
    const writer = writerOf(r);
    writer.next = () =>
      Promise.resolve({
        columns: [{ name: 'id' }],
        rows: [[7], [8]],
        affectedRows: 2,
        inTransaction: false,
      });
    const events = await collect(r.session.execute('INSERT INTO t VALUES (1) RETURNING id'));
    expect(events).toEqual([
      { kind: 'columns', columns: [{ name: 'id' }] },
      { kind: 'rows', rows: [[7], [8]] },
      { kind: 'done', affectedRows: 2 },
    ]);
  });

  it('answers done with no count for a statement that reports none', async () => {
    await collect(r.session.execute('CREATE TABLE a (id)'));
    writerOf(r).next = () => Promise.resolve({ inTransaction: false });
    expect(await collect(r.session.execute('CREATE TABLE b (id)'))).toEqual([{ kind: 'done' }]);
  });

  it('skips the rows event when the server returned none', async () => {
    await collect(r.session.execute('CREATE TABLE a (id)'));
    writerOf(r).next = () =>
      Promise.resolve({ columns: [{ name: 'id' }], rows: [], inTransaction: false });
    expect(
      (await collect(r.session.execute('DELETE FROM t RETURNING id'))).map((e) => e.kind),
    ).toEqual(['columns', 'done']);
  });

  it('starts one helper for the session, however many changes come', async () => {
    await collect(r.session.execute('INSERT INTO t VALUES (1)'));
    await collect(r.session.execute('INSERT INTO t VALUES (2)'));
    expect(r.writers).toHaveLength(1);
    expect(r.writers[0]?.ran).toHaveLength(2);
  });

  it('starts the helper once when two changes begin together', async () => {
    await Promise.all([
      collect(r.session.execute('INSERT INTO t VALUES (1)')),
      collect(r.session.execute('INSERT INTO t VALUES (2)')),
    ]);
    expect(r.writers).toHaveLength(1);
  });

  it('starts a new helper when the old one is gone', async () => {
    await collect(r.session.execute('INSERT INTO t VALUES (1)'));
    writerOf(r).alive = false;
    await collect(r.session.execute('INSERT INTO t VALUES (2)'));
    expect(r.writers).toHaveLength(2);
  });

  it('fails the change when the helper cannot start, and tries again next time', async () => {
    r.failWriter = new DbError('unsupported', 'no python3');
    await expect(collect(r.session.execute('INSERT INTO t VALUES (1)'))).rejects.toMatchObject({
      code: 'unsupported',
    });
    // Reading is not touched.
    expect((await collect(r.session.execute('SELECT 1'))).length).toBe(3);
    r.failWriter = undefined;
    await collect(r.session.execute('INSERT INTO t VALUES (1)'));
    expect(r.writers).toHaveLength(1);
  });

  describe('keeping the copy fresh', () => {
    it('makes a new copy for the next read after a change, and only then', async () => {
      await collect(r.session.execute('INSERT INTO t VALUES (1)'));
      await collect(r.session.execute('INSERT INTO t VALUES (2)'));
      // Two changes in a row cost no download: nothing was read in between.
      expect(r.leases).toHaveLength(1);
      expect(r.invalidated).toBe(2);
      const events = await collect(r.session.execute('SELECT 1'));
      expect(r.leases).toHaveLength(2);
      expect(r.locals).toHaveLength(2);
      expect(events[1]).toEqual({ kind: 'rows', rows: [['/copy-2/data.db']] });
      // The old copy and its session are let go.
      expect(r.locals[0]?.closed).toBe(true);
      expect(r.leases[0]?.released).toBe(1);
      // And the next read uses the same new copy.
      await collect(r.session.execute('SELECT 2'));
      expect(r.leases).toHaveLength(2);
    });

    it('makes a new copy when another session changed the file', async () => {
      r.deps.invalidate();
      await collect(r.session.execute('SELECT 1'));
      expect(r.locals).toHaveLength(2);
      expect(r.locals[0]?.executed).toEqual([]);
    });

    it('does not renew twice when two reads come together', async () => {
      r.deps.invalidate();
      await Promise.all([
        collect(r.session.execute('SELECT 1')),
        collect(r.session.execute('SELECT 2')),
      ]);
      expect(r.locals).toHaveLength(2);
    });

    it('lets go of the new copy when the driver cannot open it', async () => {
      r.deps.invalidate();
      const original = r.deps.openLocal.bind(r.deps);
      (r.deps as { openLocal: RemoteSqliteDeps['openLocal'] }).openLocal = () =>
        Promise.reject(new DbError('internal', 'malformed'));
      await expect(collect(r.session.execute('SELECT 1'))).rejects.toMatchObject({
        message: 'malformed',
      });
      expect(r.leases[1]?.released).toBe(1);
      (r.deps as { openLocal: RemoteSqliteDeps['openLocal'] }).openLocal = original;
      await collect(r.session.execute('SELECT 1'));
      expect(r.locals.at(-1)?.executed).toEqual(['SELECT 1']);
    });

    it('leaves the copy alone for BEGIN, ROLLBACK and changes waiting in a transaction', async () => {
      await collect(r.session.execute('BEGIN'));
      await collect(r.session.execute('INSERT INTO t VALUES (1)'));
      await collect(r.session.execute('SAVEPOINT s'));
      await collect(r.session.execute('ROLLBACK TO s'));
      expect(r.invalidated).toBe(0);
      await collect(r.session.execute('ROLLBACK'));
      expect(r.invalidated).toBe(0);
    });

    it('declares the copy old when a transaction is committed', async () => {
      await collect(r.session.execute('BEGIN'));
      await collect(r.session.execute('INSERT INTO t VALUES (1)'));
      await collect(r.session.execute('COMMIT'));
      expect(r.invalidated).toBe(1);
    });

    it('declares the copy old when the last savepoint of an implicit transaction is released', async () => {
      await collect(r.session.execute('SAVEPOINT s'));
      expect(r.invalidated).toBe(0);
      writerOf(r).inTransaction = true;
      writerOf(r).next = () => Promise.resolve({ affectedRows: 0, inTransaction: false });
      await collect(r.session.execute('RELEASE s'));
      expect(r.invalidated).toBe(1);
    });

    it('declares the copy old when the link is lost, because a commit may have gone through', async () => {
      await collect(r.session.execute('BEGIN'));
      const writer = writerOf(r);
      writer.next = () => {
        writer.alive = false;
        return Promise.reject(new DbError('connection-failed', 'lost'));
      };
      await expect(collect(r.session.execute('COMMIT'))).rejects.toMatchObject({
        code: 'connection-failed',
      });
      expect(r.invalidated).toBe(1);
      expect(r.session.transactionState()).toBe('idle');
    });

    it('keeps the copy when a statement is merely refused', async () => {
      await collect(r.session.execute('BEGIN'));
      writerOf(r).next = () => Promise.reject(new DbError('constraint', 'UNIQUE failed'));
      await expect(collect(r.session.execute('INSERT INTO t VALUES (1)'))).rejects.toMatchObject({
        code: 'constraint',
      });
      expect(r.invalidated).toBe(0);
    });

    it('renews the copy before the tree reads the structure', async () => {
      await collect(r.session.execute('CREATE TABLE x (id)'));
      const tables = await r.session.metadata.listTables({});
      expect(tables).toEqual([{ name: '[object Object]' }]);
      expect(r.locals[1]?.calls).toEqual(['listTables@/copy-2/data.db']);
      expect(r.locals[0]?.calls).toEqual([]);
    });

    it('leaves out what the driver’s reader does not have', () => {
      expect((r.session.metadata as unknown as Record<string, unknown>).tableStats).toBeUndefined();
      expect(typeof (r.session.metadata as unknown as Record<string, unknown>).listTables).toBe(
        'function',
      );
      expect(
        (r.session.metadata as unknown as Record<symbol, unknown>)[Symbol.iterator],
      ).toBeUndefined();
    });
  });

  describe('transactions', () => {
    it('says what the server said about the transaction', async () => {
      expect(r.session.transactionState()).toBe('idle');
      await collect(r.session.execute('BEGIN'));
      expect(r.session.transactionState()).toBe('open');
      await collect(r.session.execute('COMMIT'));
      expect(r.session.transactionState()).toBe('idle');
    });

    it('reads on the server while a transaction is open, so its changes are seen', async () => {
      await collect(r.session.execute('BEGIN'));
      const writer = writerOf(r);
      writer.next = () =>
        Promise.resolve({ columns: [{ name: 'n' }], rows: [[3]], inTransaction: true });
      const events = await collect(r.session.execute('SELECT count(*) AS n FROM t'));
      expect(events).toEqual([
        { kind: 'columns', columns: [{ name: 'n' }] },
        { kind: 'rows', rows: [[3]] },
        { kind: 'done' },
      ]);
      expect(writer.ran).toEqual(['BEGIN', 'SELECT count(*) AS n FROM t']);
      expect(r.locals[0]?.executed).toEqual([]);
      // Reading changed nothing on the server: the copy stays good.
      expect(r.invalidated).toBe(0);
    });

    it('goes back to the copy once the transaction has ended', async () => {
      await collect(r.session.execute('BEGIN'));
      await collect(r.session.execute('COMMIT'));
      await collect(r.session.execute('SELECT 1'));
      expect(writerOf(r).ran).toEqual(['BEGIN', 'COMMIT']);
      expect(r.locals.at(-1)?.executed).toEqual(['SELECT 1']);
    });

    it('goes back to the copy when the helper is gone, even if it had a transaction', async () => {
      await collect(r.session.execute('BEGIN'));
      writerOf(r).alive = false;
      await collect(r.session.execute('SELECT 1'));
      expect(r.locals.at(-1)?.executed).toEqual(['SELECT 1']);
    });

    it('keeps to the row limit of the request for a read on the server', async () => {
      await collect(r.session.execute('BEGIN'));
      writerOf(r).next = () =>
        Promise.resolve({
          columns: [{ name: 'n' }],
          rows: [[1], [2], [3], [4]],
          inTransaction: true,
        });
      const events = await collect(r.session.execute('SELECT n FROM t', { rowLimit: 2 }));
      expect(events[1]).toEqual({ kind: 'rows', rows: [[1], [2]] });
    });

    it('says when the server may have cut a read short', async () => {
      await collect(r.session.execute('BEGIN'));
      const rows = Array.from({ length: SERVER_ROW_CAP }, (_unused, index) => [index]);
      writerOf(r).next = () =>
        Promise.resolve({ columns: [{ name: 'n' }], rows, inTransaction: true });
      const events = await collect(r.session.execute('SELECT n FROM t'));
      expect(events.at(-1)).toEqual({
        kind: 'done',
        notice: `At most ${SERVER_ROW_CAP} rows are brought back from the server`,
      });
      writerOf(r).next = () =>
        Promise.resolve({
          columns: [{ name: 'n' }],
          rows: rows.slice(0, SERVER_ROW_CAP - 1),
          inTransaction: true,
        });
      expect((await collect(r.session.execute('SELECT n FROM t'))).at(-1)).toEqual({
        kind: 'done',
      });
    });

    it('does not start a helper to read when there was no transaction', async () => {
      await collect(r.session.execute('SELECT 1'));
      expect(r.writers).toHaveLength(0);
    });
  });

  describe('cancel and close', () => {
    it('drops the helper to stop a running change, and cancels the copy session too', async () => {
      await collect(r.session.execute('INSERT INTO t VALUES (1)'));
      await r.session.cancel();
      expect(r.writers[0]?.aborted).toBe(true);
      expect(r.locals[0]?.cancelled).toBe(1);
    });

    it('cancels reading when there is no helper', async () => {
      await r.session.cancel();
      expect(r.locals[0]?.cancelled).toBe(1);
    });

    it('closes the helper, the copy session and gives the copy back', async () => {
      await collect(r.session.execute('INSERT INTO t VALUES (1)'));
      await r.session.close();
      expect(r.writers[0]?.closedCount).toBe(1);
      expect(r.locals[0]?.closed).toBe(true);
      expect(r.leases[0]?.released).toBe(1);
      await r.session.close();
      expect(r.writers[0]?.closedCount).toBe(1);
    });

    it('gives back the newest copy, not the first', async () => {
      await collect(r.session.execute('INSERT INTO t VALUES (1)'));
      await collect(r.session.execute('SELECT 1'));
      await r.session.close();
      expect(r.leases.map((lease) => lease.released)).toEqual([1, 1]);
    });

    it('closes without a helper', async () => {
      await r.session.close();
      expect(r.locals[0]?.closed).toBe(true);
    });

    it('waits for a helper that is still starting, and closes it', async () => {
      const starting = collect(r.session.execute('INSERT INTO t VALUES (1)'));
      const closing = r.session.close();
      await Promise.all([starting.catch(() => undefined), closing]);
      expect(r.writers.every((writer) => writer.closedCount >= 1 || !writer.alive)).toBe(true);
    });

    it('refuses statements once closed', async () => {
      await r.session.close();
      await expect(collect(r.session.execute('SELECT 1'))).rejects.toMatchObject({
        code: 'internal',
      });
    });
  });
});

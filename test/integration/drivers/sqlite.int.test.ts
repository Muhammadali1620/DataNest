// The SQLite driver against real database files, with the worker bundle built
// on the fly (the packaged extension ships the same bundle in dist/drivers).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConnectionConfig } from '../../../src/core/model/connection';
import type { Driver, Session } from '../../../src/drivers/driver';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';
import { firstColumn, runAll } from '../../helpers/driver-run';

function config(file: string): ResolvedConnectionConfig {
  return { id: 'test-sqlite', name: 'test sqlite', driver: 'sqlite', file };
}

describe('sqlite driver', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let dir: string;
  let session: Session;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-sqlite-'));
    session = await driver.openSession(config(join(dir, 'main.db')));
    await runAll(
      session,
      `CREATE TABLE customers (
         id INTEGER PRIMARY KEY,
         email TEXT NOT NULL UNIQUE,
         full_name TEXT,
         balance REAL NOT NULL DEFAULT 0,
         photo BLOB,
         created_at TEXT DEFAULT '2024-01-01 00:00:00'
       )`,
    );
    await runAll(
      session,
      `INSERT INTO customers (id, email, full_name, balance, photo) VALUES
         (1, 'alice@example.com', 'Alice Johnson', 10.5, x'deadbeef'),
         (2, 'olga@example.com', 'Ольга Иванова', 0, NULL),
         (3, 'big@example.com', NULL, 0, NULL)`,
    );
    await runAll(session, 'CREATE VIEW active AS SELECT id, email FROM customers');
    await runAll(session, `CREATE TABLE big_table (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    await runAll(
      session,
      `INSERT INTO big_table (id, label)
       SELECT value, 'row-' || value FROM generate_series(1, 10000)`,
    ).catch(async () => {
      // generate_series may be missing in older builds: fall back to a recursive CTE.
      await runAll(
        session,
        `INSERT INTO big_table (id, label)
         WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 10000)
         SELECT v, 'row-' || v FROM n`,
      );
    });
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  it('creates a new database file on open', async () => {
    const fresh = await driver.openSession(config(join(dir, 'created.db')));
    const result = await runAll(fresh, 'SELECT 1 AS one');
    expect(result.rows).toEqual([[1]]);
    await fresh.close();
  });

  it('executes a select with columns, rows and done', async () => {
    const result = await runAll(session, 'SELECT id, email FROM customers ORDER BY id');
    expect(result.columnSets[0]?.map((c) => c.name)).toEqual(['id', 'email']);
    expect(result.columnSets[0]?.[0]?.dataType).toBe('integer');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual([1, 'alice@example.com']);
  });

  it('returns unicode data and NULLs intact', async () => {
    const result = await runAll(
      session,
      'SELECT full_name FROM customers WHERE id IN (2, 3) ORDER BY id',
    );
    expect(firstColumn(result)).toEqual(['Ольга Иванова', null]);
  });

  it('normalizes big integers, floats and blobs', async () => {
    const result = await runAll(session, "SELECT 9223372036854775807, 1.5, x'deadbeef', NULL");
    const row = result.rows[0];
    expect(row?.[0]).toEqual({ kind: 'bigint', text: '9223372036854775807' });
    expect(row?.[1]).toBe(1.5);
    expect(row?.[2]).toEqual({ kind: 'binary', size: 4, preview: 'deadbeef' });
    expect(row?.[3]).toBeNull();
  });

  it('reports affected rows for writes', async () => {
    const insert = await runAll(
      session,
      "INSERT INTO customers (id, email) VALUES (10, 'x@example.com'), (11, 'y@example.com')",
    );
    expect(insert.done.affectedRows).toBe(2);
    const update = await runAll(session, 'UPDATE customers SET balance = 1 WHERE id >= 10');
    expect(update.done.affectedRows).toBe(2);
    const del = await runAll(session, 'DELETE FROM customers WHERE id >= 10');
    expect(del.done.affectedRows).toBe(2);
  });

  it('stops at the row limit without leaving the session busy', async () => {
    const result = await runAll(session, 'SELECT id FROM big_table ORDER BY id', {
      rowLimit: 100,
    });
    expect(result.rows).toHaveLength(100);
    expect(result.rows[99]).toEqual([100]);
    const after = await runAll(session, 'SELECT 2');
    expect(after.rows).toEqual([[2]]);
  });

  it('maps errors: syntax, missing table, unique violation', async () => {
    await expect(runAll(session, 'SELEC 1')).rejects.toMatchObject({
      name: 'DbError',
      code: 'syntax',
    });
    await expect(runAll(session, 'SELECT * FROM nope')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(
      runAll(session, "INSERT INTO customers (id, email) VALUES (1, 'alice@example.com')"),
    ).rejects.toMatchObject({ code: 'constraint' });
  });

  it('cancel interrupts a long statement and the session recovers', async () => {
    const started = Date.now();
    const run = runAll(
      session,
      `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 100000000)
       SELECT count(*) FROM n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The statement rejects inside cancel(), so the expectation is attached first:
    // otherwise the rejection is briefly unhandled and Node reports it.
    const cancelled = expect(run).rejects.toMatchObject({ name: 'DbError', code: 'cancelled' });
    await session.cancel();
    await cancelled;
    expect(Date.now() - started).toBeLessThan(10_000);
    const after = await runAll(session, 'SELECT 3');
    expect(after.rows).toEqual([[3]]);
  });

  it('paginates through the dialect', async () => {
    const page = driver.dialect.paginate('SELECT id FROM big_table ORDER BY id', 50, 100);
    const result = await runAll(session, page);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]).toEqual([101]);
  });

  describe('metadata', () => {
    it('has no databases or schemas', async () => {
      expect(await session.metadata.listDatabases()).toEqual([]);
      await expect(session.metadata.listSchemas()).rejects.toMatchObject({
        code: 'unsupported',
      });
    });

    it('lists tables and views without sqlite internals', async () => {
      const tables = await session.metadata.listTables({});
      const byName = new Map(tables.map((t) => [t.name, t.kind]));
      expect(byName.get('customers')).toBe('table');
      expect(byName.get('active')).toBe('view');
      expect([...byName.keys()].some((name) => name.startsWith('sqlite_'))).toBe(false);
    });

    it('describes columns with type, nullability, key and default', async () => {
      const columns = await session.metadata.listColumns({ name: 'customers' });
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get('id')).toMatchObject({
        dataType: 'integer',
        primaryKey: true,
      });
      expect(byName.get('email')).toMatchObject({ nullable: false, primaryKey: false });
      expect(byName.get('full_name')).toMatchObject({ dataType: 'text', nullable: true });
      expect(byName.get('created_at')?.defaultValue).toBe("'2024-01-01 00:00:00'");
      expect(columns.map((c) => c.name)[0]).toBe('id');
    });
  });

  describe('open errors', () => {
    it('refuses a config without a file', async () => {
      await expect(
        driver.openSession({ id: 'x', name: 'x', driver: 'sqlite' }),
      ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('reports an unopenable path as connection-failed', async () => {
      await expect(
        driver.openSession(config(join(dir, 'no-such-dir', 'db.sqlite'))),
      ).rejects.toMatchObject({ code: 'connection-failed' });
    });

    it('reports a non-database file as connection-failed', async () => {
      const bogus = join(dir, 'not-a-db.txt');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(bogus, 'just text, definitely not a database page');
      const opened = await driver.openSession(config(bogus)).then(
        (s) => s,
        (error: unknown) => {
          expect(error).toMatchObject({ name: 'DbError' });
          return undefined;
        },
      );
      if (opened) {
        // Some SQLite builds only fail on first read; the error must still be mapped.
        await expect(runAll(opened, 'SELECT 1 FROM sqlite_master')).rejects.toMatchObject({
          name: 'DbError',
          code: 'connection-failed',
        });
        await opened.close();
      }
    });
  });

  it('close is idempotent and a closed session refuses to execute', async () => {
    const extra = await driver.openSession(config(join(dir, 'extra.db')));
    await extra.close();
    await extra.close();
    await expect(runAll(extra, 'SELECT 1')).rejects.toMatchObject({ code: 'internal' });
  });
});

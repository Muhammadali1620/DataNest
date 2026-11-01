import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { driver } from '../../../src/drivers/libsql';
import type { Session } from '../../../src/drivers/driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { TEST_LIBSQL } from '../../helpers/libsql-servers';

// docker/compose.yml `libsql` (V13.17): sqld over its Hrana HTTP interface, no sign-in.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'test-libsql',
    name: 'libsql',
    driver: 'libsql',
    host: TEST_LIBSQL.host,
    port: TEST_LIBSQL.port,
    ...overrides,
  };
}

/** Runs a statement and keeps the error it ends with. */
async function failure(session: Session, sql: string): Promise<DbError> {
  try {
    await runAll(session, sql);
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error(`The statement did not fail: ${sql}`);
}

describe('libsql driver on a libSQL server', () => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config());
    for (const table of ['lt_types', 'lt_tx', 'lt_meta', 'lt_child', 'lt_parent', 'lt_many']) {
      await runAll(session, `DROP TABLE IF EXISTS ${table}`);
    }
    await runAll(session, 'DROP VIEW IF EXISTS lt_view');
  });

  afterAll(async () => {
    for (const table of ['lt_types', 'lt_tx', 'lt_meta', 'lt_child', 'lt_parent', 'lt_many']) {
      await runAll(session, `DROP TABLE IF EXISTS ${table}`);
    }
    await runAll(session, 'DROP VIEW IF EXISTS lt_view');
    await session.close();
  });

  it('answers a query with typed columns', async () => {
    const result = await runAll(
      session,
      "SELECT sqlite_version() AS version, 1 + 1 AS two, 'é' AS e",
    );
    expect(result.columnSets[0]?.map((column) => column.name)).toEqual(['version', 'two', 'e']);
    expect(result.rows[0]?.[0]).toMatch(/^\d+\.\d+\.\d+/u);
    expect(result.rows[0]?.slice(1)).toEqual([2, 'é']);
  });

  it('keeps every kind of value exact', async () => {
    await runAll(
      session,
      'CREATE TABLE lt_types (id INTEGER PRIMARY KEY, big INTEGER, price REAL, name TEXT, data BLOB, empty_cell TEXT)',
    );
    await runAll(
      session,
      "INSERT INTO lt_types VALUES (1, 9223372036854775807, 1.5, 'Привет, мир — 你好', x'00ff10', NULL)",
    );
    const result = await runAll(session, 'SELECT * FROM lt_types');
    expect(result.columnSets[0]).toEqual([
      { name: 'id', dataType: 'integer' },
      { name: 'big', dataType: 'integer' },
      { name: 'price', dataType: 'real' },
      { name: 'name', dataType: 'text' },
      { name: 'data', dataType: 'blob' },
      { name: 'empty_cell', dataType: 'text' },
    ]);
    const [id, big, price, name, data, empty] = result.rows[0] ?? [];
    expect(id).toBe(1);
    expect(big).toEqual({ kind: 'bigint', text: '9223372036854775807' });
    expect(price).toBe(1.5);
    expect(name).toBe('Привет, мир — 你好');
    expect(data).toMatchObject({ kind: 'binary', size: 3, preview: '00ff10' });
    expect(empty).toBeNull();
  });

  it('counts the rows a write changed', async () => {
    await runAll(session, "INSERT INTO lt_types (id, name) VALUES (2, 'a'), (3, 'b'), (4, 'c')");
    const updated = await runAll(session, "UPDATE lt_types SET name = 'x' WHERE id > 1");
    expect(updated.done.affectedRows).toBe(3);
    const deleted = await runAll(session, 'DELETE FROM lt_types WHERE id > 1');
    expect(deleted.done.affectedRows).toBe(3);
  });

  it('reads a long result in batches, and stops at the row limit', async () => {
    const sql =
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) SELECT x FROM c';
    const all = await runAll(session, sql);
    expect(all.rows).toHaveLength(5000);
    expect(all.rows[4999]?.[0]).toBe(5000);
    const limited = await runAll(session, sql, { rowLimit: 123 });
    expect(limited.rows).toHaveLength(123);
  });

  it('pages with the SQLite dialect', async () => {
    await runAll(session, 'CREATE TABLE lt_many (n INTEGER)');
    await runAll(
      session,
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 50) INSERT INTO lt_many SELECT x FROM c',
    );
    const page = await runAll(
      session,
      driver.dialect.paginate('SELECT n FROM lt_many ORDER BY n', 10, 20),
    );
    expect(firstColumn(page)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  it('writes values the dialect renders as literals', async () => {
    const dialect = driver.dialect;
    const literal = (value: string | number): string => dialect.literal(value);
    const quoteIdentifier = (name: string): string => dialect.quoteIdentifier(name);
    await runAll(
      session,
      `INSERT INTO lt_types (id, name, price) VALUES (10, ${literal('it\'s "quoted"; DROP TABLE x')}, ${literal(2.25)})`,
    );
    const result = await runAll(
      session,
      `SELECT ${quoteIdentifier('name')}, price FROM lt_types WHERE id = 10`,
    );
    expect(result.rows[0]).toEqual(['it\'s "quoted"; DROP TABLE x', 2.25]);
    await runAll(session, 'DELETE FROM lt_types WHERE id = 10');
  });

  describe('errors', () => {
    it('calls a typo a syntax error', async () => {
      const error = await failure(session, 'SELEC 1');
      expect(error.code).toBe('syntax');
    });

    it('calls a missing table not found', async () => {
      const error = await failure(session, 'SELECT * FROM lt_nope');
      expect(error.code).toBe('not-found');
      expect(error.message).toContain('lt_nope');
    });

    it('calls a broken key a constraint', async () => {
      await runAll(session, "INSERT INTO lt_types (id, name) VALUES (20, 'k')");
      const error = await failure(session, "INSERT INTO lt_types (id, name) VALUES (20, 'again')");
      expect(error.code).toBe('constraint');
      await runAll(session, 'DELETE FROM lt_types WHERE id = 20');
    });

    it('keeps the session usable after an error', async () => {
      await failure(session, 'SELEC 1');
      expect(firstColumn(await runAll(session, 'SELECT 7'))).toEqual([7]);
    });
  });

  describe('transactions', () => {
    let other: Session;

    beforeAll(async () => {
      other = await driver.openSession(config());
      await runAll(session, 'CREATE TABLE lt_tx (id INTEGER PRIMARY KEY, v TEXT)');
    });

    afterAll(async () => {
      await other.close();
    });

    it('holds changes back until COMMIT, and shows the state as the server says', async () => {
      expect(session.transactionState?.()).toBe('idle');
      await runAll(session, 'BEGIN');
      expect(session.transactionState?.()).toBe('open');
      await runAll(session, "INSERT INTO lt_tx VALUES (1, 'kept')");
      // The statements of one session share one connection on the server.
      expect(firstColumn(await runAll(session, 'SELECT count(*) FROM lt_tx'))).toEqual([1]);
      await runAll(session, 'COMMIT');
      expect(session.transactionState?.()).toBe('idle');
      expect(firstColumn(await runAll(other, 'SELECT v FROM lt_tx'))).toEqual(['kept']);
    });

    it('takes changes back with ROLLBACK', async () => {
      await runAll(session, 'BEGIN');
      await runAll(session, "INSERT INTO lt_tx VALUES (2, 'gone')");
      await runAll(session, 'ROLLBACK');
      expect(session.transactionState?.()).toBe('idle');
      expect(firstColumn(await runAll(session, 'SELECT id FROM lt_tx ORDER BY id'))).toEqual([1]);
    });

    it('keeps the transaction open after a failed statement', async () => {
      await runAll(session, 'BEGIN');
      await failure(session, "INSERT INTO lt_tx VALUES (1, 'dup')");
      expect(session.transactionState?.()).toBe('open');
      await runAll(session, 'ROLLBACK');
      expect(session.transactionState?.()).toBe('idle');
    });

    it('keeps the changes of a transaction to its own session until COMMIT', async () => {
      await runAll(session, 'BEGIN');
      await runAll(session, "INSERT INTO lt_tx VALUES (3, 'pending')");
      expect(firstColumn(await runAll(session, 'SELECT count(*) FROM lt_tx WHERE id = 3'))).toEqual(
        [1],
      );
      expect(firstColumn(await runAll(other, 'SELECT count(*) FROM lt_tx WHERE id = 3'))).toEqual([
        0,
      ]);
      await runAll(session, 'ROLLBACK');
    });
  });

  describe('structure', () => {
    it('reads tables, views, columns, keys and indexes through the SQLite catalog', async () => {
      await runAll(session, 'CREATE TABLE lt_parent (id INTEGER PRIMARY KEY, code TEXT NOT NULL)');
      await runAll(session, 'CREATE UNIQUE INDEX lt_parent_code ON lt_parent (code)');
      await runAll(
        session,
        "CREATE TABLE lt_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES lt_parent (id), note TEXT DEFAULT 'n')",
      );
      await runAll(session, 'CREATE VIEW lt_view AS SELECT id FROM lt_parent');
      const metadata = session.metadata;
      const tables = await metadata.listTables({});
      expect(tables).toEqual(
        expect.arrayContaining([
          { name: 'lt_child', kind: 'table' },
          { name: 'lt_parent', kind: 'table' },
          { name: 'lt_view', kind: 'view' },
        ]),
      );
      expect(await metadata.listColumns({ name: 'lt_child' })).toEqual([
        { name: 'id', dataType: 'integer', nullable: true, primaryKey: true },
        { name: 'parent_id', dataType: 'integer', nullable: true, primaryKey: false },
        {
          name: 'note',
          dataType: 'text',
          nullable: true,
          primaryKey: false,
          defaultValue: "'n'",
        },
      ]);
      expect(await metadata.listUniqueKeys({ name: 'lt_parent' })).toEqual([['code']]);
      const keys = await metadata.listForeignKeys({ name: 'lt_child' });
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({
        columns: ['parent_id'],
        target: { name: 'lt_parent' },
        targetColumns: ['id'],
      });
      const indexes = await metadata.listIndexes({ name: 'lt_parent' });
      expect(indexes.map((index) => index.name)).toContain('lt_parent_code');
    });

    it('gives the definition of a table and of a view', async () => {
      const table = await session.metadata.getDefinition({ kind: 'table', name: 'lt_child' });
      expect(table.join('\n')).toMatch(/CREATE TABLE "?lt_child"?/iu);
      const view = await session.metadata.getDefinition({ kind: 'view', name: 'lt_view' });
      expect(view.join('\n')).toMatch(/CREATE VIEW lt_view/iu);
    });

    it('describes a table for the designer', async () => {
      const structure = await session.metadata.describeTable({ name: 'lt_parent' });
      expect(structure.columns.map((column) => column.name)).toEqual(['id', 'code']);
    });
  });

  describe('cancelling', () => {
    it('stops a statement that would never end, and carries on', async () => {
      const slow = new Promise<unknown>((resolve) => {
        runAll(
          session,
          'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
        ).then(resolve, resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await session.cancel();
      const ended = await slow;
      expect(ended).toBeInstanceOf(DbError);
      expect((ended as DbError).code).toBe('cancelled');
      expect(firstColumn(await runAll(session, 'SELECT 9'))).toEqual([9]);
    });
  });

  describe('a read-only connection', () => {
    let reader: Session;

    beforeAll(async () => {
      reader = await driver.openSession(config({ readOnly: true }));
    });

    afterAll(async () => {
      await reader.close();
    });

    it('opens and reads, whether or not the server takes PRAGMA query_only', async () => {
      // sqld answers "unsupported statement" to the pragma; the session goes on without it
      // and DataNest itself refuses the statements that change data (V4.6).
      expect(firstColumn(await runAll(reader, 'SELECT count(*) FROM lt_parent'))).toEqual([0]);
      expect(firstColumn(await runAll(reader, 'SELECT 5'))).toEqual([5]);
    });
  });

  describe('connecting', () => {
    it('fails an unreachable server as a failed connection', async () => {
      await expect(driver.openSession(config({ port: 1 }))).rejects.toMatchObject({
        code: 'connection-failed',
      });
    });

    it('takes the address as a URL in the host field', async () => {
      const viaUrl = await driver.openSession(
        config({ host: `http://${TEST_LIBSQL.host}:${TEST_LIBSQL.port}`, port: undefined }),
      );
      expect(firstColumn(await runAll(viaUrl, 'SELECT 3'))).toEqual([3]);
      await viaUrl.close();
    });

    it('offers a token to a server that does not ask for one', async () => {
      const withToken = await driver.openSession(config({ password: 'not-needed' }));
      expect(firstColumn(await runAll(withToken, 'SELECT 4'))).toEqual([4]);
      await withToken.close();
    });

    it('closes a session at once, and more than once', async () => {
      const brief = await driver.openSession(config());
      await brief.close();
      await brief.close();
      await expect(runAll(brief, 'SELECT 1')).rejects.toMatchObject({ code: 'internal' });
    });
  });
});

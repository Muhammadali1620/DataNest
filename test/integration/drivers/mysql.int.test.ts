// The MySQL driver against the real MySQL 8 and MariaDB from docker/compose.yml.
// Both servers share one seed (docker/seed/mysql), so the suite runs twice.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { driver } from '../../../src/drivers/mysql';
import type { Session } from '../../../src/drivers/driver';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';

function config(id: TestDatabaseId, overrides: Partial<ResolvedConnectionConfig> = {}) {
  const db = testDatabase(id);
  return {
    id: `test-${id}`,
    name: `test ${id}`,
    driver: 'mysql',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ...overrides,
  } as ResolvedConnectionConfig;
}

describe.each(['mysql', 'mariadb'] as const)('mysql driver on %s', (serverId) => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config(serverId));
  });

  afterAll(async () => {
    await session.close();
  });

  it('executes a simple select with columns, rows and done', async () => {
    const result = await runAll(session, 'SELECT 1 AS one');
    expect(result.columnSets).toHaveLength(1);
    expect(result.columnSets[0]?.map((c) => c.name)).toEqual(['one']);
    expect(result.rows).toEqual([[1]]);
  });

  it('returns unicode data intact', async () => {
    const result = await runAll(
      session,
      'SELECT full_name FROM customers WHERE id IN (3, 4) ORDER BY id',
    );
    expect(firstColumn(result)).toEqual(['Ольга Иванова', '山田 博']);
  });

  it('emits columns for a select with zero rows', async () => {
    const result = await runAll(session, 'SELECT id, email FROM customers WHERE id = -1');
    expect(result.columnSets[0]?.map((c) => c.name)).toEqual(['id', 'email']);
    expect(result.rows).toEqual([]);
  });

  it('normalizes precision-critical types without loss', async () => {
    const result = await runAll(
      session,
      `SELECT c_bigint, c_bigint_unsigned, c_decimal, c_datetime, c_json, c_binary, c_bool, c_bit
       FROM all_types WHERE id = 1`,
    );
    const row = result.rows[0];
    expect(row?.[0]).toEqual({ kind: 'bigint', text: '9223372036854775807' });
    expect(row?.[1]).toEqual({ kind: 'bigint', text: '18446744073709551615' });
    expect(row?.[2]).toEqual({ kind: 'decimal', text: '12345678901234567890.0123456789' });
    expect(row?.[3]).toEqual({ kind: 'datetime', text: '2024-12-31 23:59:59.123456' });
    // MariaDB has no native JSON type: the column arrives as plain text there.
    const json = row?.[4];
    const jsonText =
      typeof json === 'object' && json?.kind === 'json'
        ? json.text
        : typeof json === 'string'
          ? json
          : undefined;
    if (serverId === 'mysql' && (typeof json !== 'object' || json?.kind !== 'json')) {
      throw new Error(`expected a tagged json value, got ${JSON.stringify(json)}`);
    }
    if (jsonText === undefined) {
      throw new Error(`expected json text, got ${JSON.stringify(json)}`);
    }
    expect(JSON.parse(jsonText)).toMatchObject({ unicode: '日本語' });
    expect(row?.[5]).toEqual({ kind: 'binary', size: 4, preview: 'deadbeef' });
    expect(row?.[6]).toBe(1);
    expect(row?.[7]).toMatchObject({ kind: 'binary', size: 1 });
  });

  it('returns NULL for every column of the empty row', async () => {
    const result = await runAll(
      session,
      'SELECT c_bigint, c_decimal, c_datetime, c_json, c_binary FROM all_types WHERE id = 2',
    );
    expect(result.rows[0]).toEqual([null, null, null, null, null]);
  });

  it('reports affected rows for writes', async () => {
    await runAll(session, 'CREATE TEMPORARY TABLE tmp_v13 (id INT PRIMARY KEY, n INT)');
    try {
      const insert = await runAll(session, 'INSERT INTO tmp_v13 VALUES (1, 10), (2, 20)');
      expect(insert.done.affectedRows).toBe(2);
      expect(insert.columnSets).toEqual([]);
      const update = await runAll(session, 'UPDATE tmp_v13 SET n = n + 1');
      expect(update.done.affectedRows).toBe(2);
    } finally {
      await runAll(session, 'DROP TEMPORARY TABLE tmp_v13');
    }
  });

  it('stops at the row limit and still finishes cleanly', async () => {
    const result = await runAll(session, 'SELECT id FROM big_table ORDER BY id', {
      rowLimit: 100,
    });
    expect(result.rows).toHaveLength(100);
    expect(result.rows[99]).toEqual([100]);
    // The session stays usable after the early kill.
    const after = await runAll(session, 'SELECT 2');
    expect(after.rows).toEqual([[2]]);
  });

  it('maps a syntax error with sqlState', async () => {
    await expect(runAll(session, 'SELECTT 1')).rejects.toMatchObject({
      name: 'DbError',
      code: 'syntax',
      sqlState: '42000',
    });
  });

  it('maps a missing table to not-found and a duplicate key to constraint', async () => {
    await expect(runAll(session, 'SELECT * FROM no_such_table_v13')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(
      runAll(session, "INSERT INTO customers (id, email) VALUES (1, 'alice@example.com')"),
    ).rejects.toMatchObject({ code: 'constraint' });
  });

  it('cancel interrupts a long statement quickly', async () => {
    const started = Date.now();
    const run = runAll(session, 'SELECT id, SLEEP(0.05) FROM big_table ORDER BY id');
    // Depending on the server, a killed query either errors with "interrupted" or
    // completes early; both are fine as long as it does not run to the end. The
    // handler is attached before the cancel, so a rejection is never left loose.
    const settled = run.then(
      () => 'finished' as const,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel();
    const outcome = await settled;
    if (outcome !== 'finished') {
      expect(outcome).toMatchObject({ name: 'DbError', code: 'cancelled' });
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    const after = await runAll(session, 'SELECT 3');
    expect(after.rows).toEqual([[3]]);
  });

  it('fails the running statement when the server ends the session (V8.5)', async () => {
    const victim = await driver.openSession(config(serverId));
    try {
      const [id] = firstColumn(await runAll(victim, 'SELECT CONNECTION_ID()'));
      const started = Date.now();
      const settled = runAll(victim, 'SELECT SLEEP(20)').then(
        () => 'finished' as const,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runAll(session, `KILL CONNECTION ${Number(id)}`);
      expect(await settled).toMatchObject({ name: 'DbError', code: 'connection-failed' });
      expect(Date.now() - started).toBeLessThan(10_000);
      // Later statements fail at once instead of waiting forever.
      await expect(runAll(victim, 'SELECT 1')).rejects.toMatchObject({
        code: 'connection-failed',
      });
    } finally {
      await victim.close();
    }
  });

  it('runs a stored procedure with a result set', async () => {
    const result = await runAll(session, 'CALL customer_orders(1)');
    expect(result.columnSets).toHaveLength(1);
    expect(result.rows.map((row) => row[0])).toEqual([1, 2]);
  });

  it('paginates through the dialect', async () => {
    const page = driver.dialect.paginate('SELECT id FROM big_table ORDER BY id', 50, 100);
    const result = await runAll(session, page);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]).toEqual([101]);
    expect(result.rows[49]).toEqual([150]);
  });

  describe('metadata', () => {
    it('lists databases including the seeded ones', async () => {
      const databases = await session.metadata.listDatabases();
      expect(databases).toContain('datanest_test');
      expect(databases).toContain('datanest_empty');
    });

    it('lists tables and views of the current database', async () => {
      const tables = await session.metadata.listTables({});
      const byName = new Map(tables.map((t) => [t.name, t.kind]));
      expect(byName.get('customers')).toBe('table');
      expect(byName.get('big_table')).toBe('table');
      expect(byName.get('order_totals')).toBe('view');
    });

    it('reads estimated rows, size and comment from the statistics (V10.2.3)', async () => {
      await runAll(session, 'DROP TABLE IF EXISTS datanest_empty.stats_probe');
      await runAll(
        session,
        "CREATE TABLE datanest_empty.stats_probe (id int PRIMARY KEY) COMMENT = 'Probe of statistics'",
      );
      try {
        await runAll(session, 'INSERT INTO datanest_empty.stats_probe VALUES (1), (2), (3)');
        await runAll(session, 'ANALYZE TABLE datanest_empty.stats_probe');
        const [probe] = (await session.metadata.tableStats?.({ database: 'datanest_empty' })) ?? [];
        expect(probe?.name).toBe('stats_probe');
        expect(probe?.comment).toBe('Probe of statistics');
        expect(probe?.rows).toBeGreaterThanOrEqual(0);
        expect(probe?.rows).toBeLessThan(100);
        expect(probe?.bytes).toBeGreaterThan(0);
        // Views have no rows, and the server's comment "VIEW" is not theirs.
        await runAll(session, 'ANALYZE TABLE datanest_test.big_table');
        const all = (await session.metadata.tableStats?.({ database: 'datanest_test' })) ?? [];
        const view = all.find((entry) => entry.name === 'order_totals');
        expect(view).toEqual({ name: 'order_totals' });
        const big = all.find((entry) => entry.name === 'big_table');
        expect(big?.rows).toBeGreaterThan(1000);
      } finally {
        await runAll(session, 'DROP TABLE datanest_empty.stats_probe');
      }
    });

    it('lists tables of an explicit database and an empty database', async () => {
      const tables = await session.metadata.listTables({ database: 'datanest_test' });
      expect(tables.length).toBeGreaterThanOrEqual(6);
      expect(await session.metadata.listTables({ database: 'datanest_empty' })).toEqual([]);
    });

    it('lists unique keys other than the primary key', async () => {
      const scope = { database: 'datanest_test' };
      expect(await session.metadata.listUniqueKeys({ ...scope, name: 'customers' })).toEqual([
        ['email'],
      ]);
      expect(await session.metadata.listUniqueKeys({ ...scope, name: 'order_items' })).toEqual([]);
      expect(await session.metadata.listUniqueKeys({ ...scope, name: 'nope' })).toEqual([]);
    });

    it('lists foreign keys with their targets', async () => {
      const scope = { database: 'datanest_test' };
      const keys = await session.metadata.listForeignKeys({ ...scope, name: 'order_items' });
      // MariaDB names the default action RESTRICT; for InnoDB it is the same as NO ACTION.
      const byDefault = serverId === 'mariadb' ? 'RESTRICT' : 'NO ACTION';
      expect(keys).toEqual([
        {
          name: 'fk_items_order',
          columns: ['order_id'],
          target: { database: 'datanest_test', name: 'orders' },
          targetColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: byDefault,
        },
        {
          name: 'fk_items_product',
          columns: ['product_id'],
          target: { database: 'datanest_test', name: 'products' },
          targetColumns: ['id'],
          onDelete: byDefault,
          onUpdate: byDefault,
        },
      ]);
      expect(await session.metadata.listForeignKeys({ ...scope, name: 'customers' })).toEqual([]);
      expect(await session.metadata.listForeignKeys({ ...scope, name: 'nope' })).toEqual([]);
    });

    it('describes columns with type, nullability, key and default', async () => {
      const columns = await session.metadata.listColumns({
        database: 'datanest_test',
        name: 'customers',
      });
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get('id')).toMatchObject({ primaryKey: true, nullable: false });
      expect(byName.get('id')?.dataType).toMatch(/^int/);
      expect(byName.get('full_name')).toMatchObject({
        dataType: 'varchar(255)',
        nullable: true,
        primaryKey: false,
      });
      expect(byName.get('created_at')?.defaultValue).toBe('2024-01-01 00:00:00');
      expect(columns.map((c) => c.name)[0]).toBe('id');
    });

    it('rejects listSchemas as unsupported', async () => {
      await expect(session.metadata.listSchemas()).rejects.toMatchObject({
        code: 'unsupported',
      });
    });
  });

  describe('connection errors', () => {
    it('reports wrong credentials as auth-failed', async () => {
      await expect(
        driver.openSession(config(serverId, { password: 'wrong-password' })),
      ).rejects.toMatchObject({ name: 'DbError', code: 'auth-failed' });
    });

    it('reports an unreachable server as connection-failed', async () => {
      await expect(driver.openSession(config(serverId, { port: 7999 }))).rejects.toMatchObject({
        name: 'DbError',
        code: 'connection-failed',
      });
    });
  });

  it('close is idempotent and a closed session refuses to execute', async () => {
    const extra = await driver.openSession(config(serverId));
    await extra.close();
    await extra.close();
    await expect(runAll(extra, 'SELECT 1')).rejects.toMatchObject({ code: 'internal' });
  });
});

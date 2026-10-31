// The PostgreSQL driver against the real PostgreSQL 17 from docker/compose.yml.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/postgres';
import { testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';

function config(overrides: Partial<ResolvedConnectionConfig> = {}) {
  const db = testDatabase('postgres');
  return {
    id: 'test-postgres',
    name: 'test postgres',
    driver: 'postgres',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ...overrides,
  } as ResolvedConnectionConfig;
}

describe('postgres driver', () => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config());
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
      `SELECT c_bigint, c_numeric, c_timestamp, c_timestamptz, c_jsonb, c_bytea, c_bool,
              c_int_array, c_uuid, c_interval, c_status
       FROM all_types WHERE id = 1`,
    );
    const row = result.rows[0];
    expect(row?.[0]).toEqual({ kind: 'bigint', text: '9223372036854775807' });
    expect(row?.[1]).toEqual({ kind: 'decimal', text: '12345678901234567890.0123456789' });
    expect(row?.[2]).toEqual({ kind: 'datetime', text: '2024-12-31 23:59:59.123456' });
    expect(row?.[3]).toMatchObject({ kind: 'datetime' });
    const json = row?.[4];
    if (typeof json !== 'object' || json?.kind !== 'json') {
      throw new Error(`expected a json value, got ${JSON.stringify(json)}`);
    }
    expect(JSON.parse(json.text)).toMatchObject({ unicode: '日本語' });
    expect(row?.[5]).toEqual({ kind: 'binary', size: 4, preview: 'deadbeef' });
    expect(row?.[6]).toBe(true);
    expect(row?.[7]).toBe('{1,2,3}');
    expect(row?.[8]).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(row?.[9]).toBe('1 year 2 mons 3 days 04:05:06');
    expect(row?.[10]).toBe('paid');
  });

  it('returns NULL for every column of the empty row', async () => {
    const result = await runAll(
      session,
      'SELECT c_bigint, c_numeric, c_timestamp, c_jsonb, c_bytea FROM all_types WHERE id = 2',
    );
    expect(result.rows[0]).toEqual([null, null, null, null, null]);
  });

  it('reports affected rows for writes', async () => {
    await runAll(session, 'CREATE TEMPORARY TABLE tmp_v14 (id INT PRIMARY KEY, n INT)');
    try {
      const insert = await runAll(session, 'INSERT INTO tmp_v14 VALUES (1, 10), (2, 20)');
      expect(insert.done.affectedRows).toBe(2);
      expect(insert.columnSets).toEqual([]);
      const update = await runAll(session, 'UPDATE tmp_v14 SET n = n + 1');
      expect(update.done.affectedRows).toBe(2);
      const returning = await runAll(session, 'DELETE FROM tmp_v14 WHERE id = 1 RETURNING id');
      expect(returning.rows).toEqual([[1]]);
    } finally {
      await runAll(session, 'DROP TABLE tmp_v14');
    }
  });

  it('stops at the row limit and still finishes cleanly', async () => {
    const result = await runAll(session, 'SELECT id FROM big_table ORDER BY id', {
      rowLimit: 100,
    });
    expect(result.rows).toHaveLength(100);
    expect(result.rows[99]).toEqual([100]);
    const after = await runAll(session, 'SELECT 2');
    expect(after.rows).toEqual([[2]]);
  });

  it('maps a syntax error with its position in the SQL', async () => {
    const error = await runAll(session, 'SELECT 1 FROMM t').then(
      () => undefined,
      (raised: unknown) => raised,
    );
    expect(error).toMatchObject({ name: 'DbError', code: 'syntax', sqlState: '42601' });
    expect((error as { position?: number }).position).toBeGreaterThanOrEqual(0);
  });

  it('maps a missing table to not-found and a duplicate key to constraint', async () => {
    await expect(runAll(session, 'SELECT * FROM no_such_table_v14')).rejects.toMatchObject({
      code: 'not-found',
      sqlState: '42P01',
    });
    await expect(
      runAll(session, "INSERT INTO customers (id, email) VALUES (1, 'alice@example.com')"),
    ).rejects.toMatchObject({ code: 'constraint', sqlState: '23505' });
  });

  it('cancel interrupts a long statement quickly', async () => {
    const started = Date.now();
    const run = runAll(session, 'SELECT pg_sleep(30)');
    // The statement rejects inside cancel(), so the expectation is attached first:
    // otherwise the rejection is briefly unhandled and Node reports it.
    const cancelled = expect(run).rejects.toMatchObject({ name: 'DbError', code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    expect(result.rows[49]).toEqual([150]);
  });

  describe('metadata', () => {
    it('lists databases without templates', async () => {
      const databases = await session.metadata.listDatabases();
      expect(databases).toContain('datanest_test');
      expect(databases).toContain('postgres');
      expect(databases).not.toContain('template0');
    });

    it('lists schemas with public first', async () => {
      const schemas = await session.metadata.listSchemas();
      expect(schemas[0]).toBe('public');
      expect(schemas).toContain('pg_catalog');
      expect(schemas).toContain('information_schema');
    });

    it('lists tables and views of a schema', async () => {
      const tables = await session.metadata.listTables({ schema: 'public' });
      const byName = new Map(tables.map((t) => [t.name, t.kind]));
      expect(byName.get('customers')).toBe('table');
      expect(byName.get('order_totals')).toBe('view');
      expect(await session.metadata.listTables({ schema: 'no_such_schema' })).toEqual([]);
    });

    it('reads estimated rows, size and comment from the statistics (V10.2.3)', async () => {
      await runAll(session, 'DROP TABLE IF EXISTS public.stats_probe');
      await runAll(session, 'CREATE TABLE public.stats_probe (id int PRIMARY KEY)');
      try {
        await runAll(session, "COMMENT ON TABLE public.stats_probe IS 'Probe of statistics'");
        // Before the first ANALYZE the server does not know the rows.
        const before = await session.metadata.tableStats?.({ schema: 'public' });
        expect(before?.find((entry) => entry.name === 'stats_probe')?.rows).toBeUndefined();
        await runAll(session, 'INSERT INTO public.stats_probe SELECT generate_series(1, 500)');
        await runAll(session, 'ANALYZE public.stats_probe');
        const stats = (await session.metadata.tableStats?.({ schema: 'public' })) ?? [];
        const probe = stats.find((entry) => entry.name === 'stats_probe');
        expect(probe).toMatchObject({ rows: 500, comment: 'Probe of statistics' });
        expect(probe?.bytes).toBeGreaterThan(0);
        expect(stats.find((entry) => entry.name === 'order_totals')?.rows).toBeUndefined();
        expect(await session.metadata.tableStats?.({ schema: 'no_such_schema' })).toEqual([]);
      } finally {
        await runAll(session, 'DROP TABLE public.stats_probe');
      }
    });

    it('defaults to the public schema', async () => {
      const tables = await session.metadata.listTables({});
      expect(tables.map((t) => t.name)).toContain('customers');
    });

    it('lists unique keys other than the primary key', async () => {
      expect(
        await session.metadata.listUniqueKeys({ schema: 'public', name: 'customers' }),
      ).toEqual([['email']]);
      expect(
        await session.metadata.listUniqueKeys({ schema: 'inventory', name: 'warehouses' }),
      ).toEqual([['code']]);
      expect(
        await session.metadata.listUniqueKeys({ schema: 'public', name: 'order_items' }),
      ).toEqual([]);
    });

    it('lists foreign keys, also into another schema', async () => {
      const items = await session.metadata.listForeignKeys({
        schema: 'public',
        name: 'order_items',
      });
      expect(items.map((key) => [key.columns, key.target, key.targetColumns])).toEqual([
        [['order_id'], { schema: 'public', name: 'orders' }, ['id']],
        [['product_id'], { schema: 'public', name: 'products' }, ['id']],
      ]);
      const stock = await session.metadata.listForeignKeys({
        schema: 'inventory',
        name: 'stock_levels',
      });
      expect(stock.map((key) => key.target)).toEqual([
        { schema: 'inventory', name: 'warehouses' },
        { schema: 'public', name: 'products' },
      ]);
      expect(
        await session.metadata.listForeignKeys({ schema: 'public', name: 'customers' }),
      ).toEqual([]);
    });

    it('describes columns with type, nullability, key and default', async () => {
      const columns = await session.metadata.listColumns({ schema: 'public', name: 'customers' });
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get('id')).toMatchObject({
        dataType: 'integer',
        primaryKey: true,
        nullable: false,
      });
      expect(byName.get('id')?.defaultValue).toContain('nextval');
      expect(byName.get('full_name')).toMatchObject({
        dataType: 'character varying(255)',
        nullable: true,
        primaryKey: false,
      });
      expect(columns.map((c) => c.name)[0]).toBe('id');
    });
  });

  describe('connection errors', () => {
    it('reports wrong credentials as auth-failed', async () => {
      await expect(
        driver.openSession(config({ password: 'wrong-password' })),
      ).rejects.toMatchObject({ name: 'DbError', code: 'auth-failed' });
    });

    it('reports an unreachable server as connection-failed', async () => {
      await expect(driver.openSession(config({ port: 7999 }))).rejects.toMatchObject({
        name: 'DbError',
        code: 'connection-failed',
      });
    });

    it('reports a missing database as not-found', async () => {
      await expect(
        driver.openSession(config({ database: 'no_such_db_v14' })),
      ).rejects.toMatchObject({ name: 'DbError', code: 'not-found' });
    });
  });

  it('close is idempotent and a closed session refuses to execute', async () => {
    const extra = await driver.openSession(config());
    await extra.close();
    await extra.close();
    await expect(runAll(extra, 'SELECT 1')).rejects.toMatchObject({ code: 'internal' });
  });
});

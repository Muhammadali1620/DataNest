import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { testDatabase } from '../../helpers/databases';

// Checks that docker/seed/postgres produced the data later tests depend on.
describe('postgres seed', () => {
  const db = testDatabase('postgres');
  const client = new pg.Client({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  });

  // Keep every value as the server's text, so the test sees exactly what is stored.
  const asText = { getTypeParser: () => (value: string) => value };

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await client.query({ text: sql, values: params, types: asText });
    return result.rows as T[];
  }

  async function scalar(sql: string, params: unknown[] = []): Promise<unknown> {
    const [first] = await rows<Record<string, unknown>>(sql, params);
    return first === undefined ? undefined : Object.values(first)[0];
  }

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('runs in UTC with UTF-8', async () => {
    expect(await scalar('SHOW TimeZone')).toBe('UTC');
    expect(await scalar('SHOW server_encoding')).toBe('UTF8');
  });

  it('has the public and inventory schemas', async () => {
    const schemas = await rows<{ name: string }>(
      `SELECT nspname AS name FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname`,
    );
    expect(schemas.map((s) => s.name)).toEqual(['inventory', 'public']);
  });

  it('has the expected relations in public', async () => {
    const relations = await rows<{ name: string; kind: string }>(
      `SELECT c.relname AS name, c.relkind::text AS kind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S') ORDER BY c.relname`,
    );
    expect(relations).toEqual([
      { name: 'all_types', kind: 'r' },
      { name: 'big_table', kind: 'r' },
      { name: 'customers', kind: 'r' },
      { name: 'customers_id_seq', kind: 'S' },
      { name: 'invoice_number_seq', kind: 'S' },
      { name: 'order_items', kind: 'r' },
      { name: 'order_totals', kind: 'v' },
      { name: 'orders', kind: 'r' },
      { name: 'orders_id_seq', kind: 'S' },
      { name: 'product_sales', kind: 'm' },
      { name: 'products', kind: 'r' },
      { name: 'products_id_seq', kind: 'S' },
    ]);
  });

  it.each([
    ['customers', 5],
    ['products', 6],
    ['orders', 8],
    ['order_items', 12],
    ['all_types', 2],
    ['big_table', 10_000],
    ['inventory.warehouses', 2],
    ['inventory.stock_levels', 4],
    ['product_sales', 6],
  ])('has the seeded rows in %s', async (table, count) => {
    expect(Number(await scalar(`SELECT COUNT(*) FROM ${table}`))).toBe(count);
  });

  it('numbers big_table rows 1..10000 without gaps', async () => {
    expect(await scalar('SELECT SUM(id) FROM big_table')).toBe('50005000');
    expect(await scalar('SELECT label FROM big_table WHERE id = 42')).toBe('row-00042');
  });

  it('continues sequences after the seeded ids', async () => {
    expect(await scalar('SELECT last_value FROM customers_id_seq')).toBe('5');
    expect(await scalar('SELECT last_value FROM inventory.warehouses_id_seq')).toBe('2');
  });

  it('stores Unicode, quotes and NULLs exactly', async () => {
    const customers = await rows<{ full_name: string | null }>(
      'SELECT full_name FROM customers ORDER BY id',
    );
    expect(customers.map((c) => c.full_name)).toEqual([
      'Alice Johnson',
      "Bob O'Brien",
      'Ольга Иванова',
      '山田 博',
      null,
    ]);
    expect(await scalar('SELECT name FROM products WHERE id = 5')).toBe('Rocket Mug 🚀');
  });

  it('computes order totals in the view', async () => {
    const totals = await rows<{ order_id: string; total: string }>(
      'SELECT order_id, total FROM order_totals ORDER BY order_id',
    );
    expect(totals.map((t) => [t.order_id, t.total])).toEqual([
      ['1', '88.99'],
      ['2', '329.00'],
      ['3', '48.00'],
      ['4', '120.49'],
      ['5', '29.97'],
      ['6', '677.50'],
      ['7', '12.00'],
      ['8', '93.75'],
    ]);
  });

  it('has the order_status enum in order', async () => {
    expect(await scalar('SELECT enum_range(NULL::order_status)::text')).toBe(
      '{new,paid,shipped,cancelled}',
    );
  });

  it('has the order_total function and the restock procedure', async () => {
    expect(await scalar('SELECT order_total($1)', [6])).toBe('677.50');
    expect(await scalar('SELECT order_total($1)', [999])).toBe('0.00');
    await client.query('BEGIN');
    try {
      await client.query('CALL restock($1, $2)', [4, 10]);
      expect(await scalar('SELECT stock FROM products WHERE id = 4')).toBe('10');
    } finally {
      await client.query('ROLLBACK');
    }
    expect(await scalar('SELECT stock FROM products WHERE id = 4')).toBe('0');
  });

  it('rejects a non-positive quantity through the trigger', async () => {
    await expect(
      client.query('INSERT INTO order_items VALUES (3, 1, 0, 49.99)'),
    ).rejects.toMatchObject({ code: '23514', message: 'quantity must be positive' });
  });

  it('enforces foreign keys across schemas', async () => {
    await expect(
      client.query('INSERT INTO inventory.stock_levels VALUES (1, 999, 1)'),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('fills every column of all_types row 1 and none of row 2', async () => {
    const [full, empty] = await rows<Record<string, string | null>>(
      'SELECT * FROM all_types ORDER BY id',
    );
    expect(full).toEqual({
      id: '1',
      c_smallint: '32767',
      c_int: '2147483647',
      c_bigint: '9223372036854775807',
      c_numeric: '12345678901234567890.0123456789',
      c_real: '1.5',
      c_double: '3.141592653589793',
      c_bool: 't',
      c_char: 'abc',
      c_varchar: 'O\'Brien "quoted" \\ backslash',
      c_text: 'Многострочный\nтекст 🚀',
      c_date: '2024-02-29',
      c_time: '23:59:59',
      c_timetz: '23:59:59+03',
      c_timestamp: '2024-12-31 23:59:59.123456',
      c_timestamptz: '2024-06-15 12:00:00+00',
      c_interval: '1 year 2 mons 3 days 04:05:06',
      c_uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      c_json: '{"nested": {"list": [1, 2, 3]}, "unicode": "日本語"}',
      c_jsonb: '{"nested": {"list": [1, 2, 3]}, "unicode": "日本語"}',
      c_bytea: '\\xdeadbeef',
      c_int_array: '{1,2,3}',
      c_text_array: '{a,"b c",NULL}',
      c_inet: '192.168.0.1/24',
      c_status: 'paid',
    });
    const { id, ...rest } = empty ?? {};
    expect(id).toBe('2');
    expect(Object.values(rest).every((value) => value === null)).toBe(true);
  });

  it('has an empty second database', async () => {
    expect(
      await scalar('SELECT COUNT(*) FROM pg_database WHERE datname = $1', [db.emptyDatabase]),
    ).toBe('1');
    const other = new pg.Client({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.emptyDatabase,
    });
    await other.connect();
    try {
      const result = await other.query(
        "SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(result.rows[0]).toEqual({ count: 0 });
    } finally {
      await other.end();
    }
  });
});

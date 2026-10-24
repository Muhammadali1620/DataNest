import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';

// Checks that docker/seed/mysql produced the data later tests depend on, in both MySQL and MariaDB.
const IDS: TestDatabaseId[] = ['mysql', 'mariadb'];

describe.each(IDS)('%s seed', (id) => {
  const db = testDatabase(id);
  let conn: Connection;

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [result] = await conn.query<RowDataPacket[]>(sql, params);
    return result as T[];
  }

  async function scalar(sql: string, params: unknown[] = []): Promise<unknown> {
    const [first] = await rows<Record<string, unknown>>(sql, params);
    return first === undefined ? undefined : Object.values(first)[0];
  }

  beforeAll(async () => {
    conn = await mysql.createConnection({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
    });
  });

  afterAll(async () => {
    await conn.end();
  });

  it('runs in UTC with utf8mb4', async () => {
    expect(await scalar('SELECT @@session.time_zone')).toMatch(/^(\+00:00|UTC|SYSTEM)$/);
    expect(Number(await scalar('SELECT TIMESTAMPDIFF(HOUR, UTC_TIMESTAMP(), NOW())'))).toBe(0);
    expect(await scalar('SELECT @@character_set_database')).toBe('utf8mb4');
  });

  it('has the expected tables and views', async () => {
    const tables = await rows<{ name: string; type: string }>(
      `SELECT table_name AS name, table_type AS type FROM information_schema.tables
       WHERE table_schema = ?`,
      [db.database],
    );
    // information_schema collations differ between MySQL and MariaDB, so sort here.
    tables.sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(tables).toEqual([
      { name: 'all_types', type: 'BASE TABLE' },
      { name: 'big_table', type: 'BASE TABLE' },
      { name: 'customers', type: 'BASE TABLE' },
      { name: 'order_items', type: 'BASE TABLE' },
      { name: 'order_totals', type: 'VIEW' },
      { name: 'orders', type: 'BASE TABLE' },
      { name: 'products', type: 'BASE TABLE' },
    ]);
  });

  it.each([
    ['customers', 5],
    ['products', 6],
    ['orders', 8],
    ['order_items', 12],
    ['all_types', 2],
    ['big_table', 10_000],
  ])('has the seeded rows in %s', async (table, count) => {
    expect(Number(await scalar(`SELECT COUNT(*) FROM ${table}`))).toBe(count);
  });

  it('numbers big_table rows 1..10000 without gaps', async () => {
    const [stats] = await rows<{ min: string; max: string; sum: string; labels: string }>(
      'SELECT MIN(id) AS min, MAX(id) AS max, SUM(id) AS sum, COUNT(DISTINCT label) AS labels FROM big_table',
    );
    // BIGINT results (SUM, COUNT) come back as strings with bigNumberStrings.
    expect({
      min: Number(stats?.min),
      max: Number(stats?.max),
      sum: stats?.sum,
      labels: Number(stats?.labels),
    }).toEqual({ min: 1, max: 10_000, sum: '50005000', labels: 10_000 });
    expect(await scalar('SELECT label FROM big_table WHERE id = 42')).toBe('row-00042');
  });

  it('stores Unicode, quotes and NULLs exactly', async () => {
    const customers = await rows<{ id: number; full_name: string | null }>(
      'SELECT id, full_name FROM customers ORDER BY id',
    );
    expect(customers.map((c) => c.full_name)).toEqual([
      'Alice Johnson',
      "Bob O'Brien",
      'Ольга Иванова',
      '山田 博',
      null,
    ]);
    expect(await scalar('SELECT name FROM products WHERE id = 5')).toBe('Rocket Mug 🚀');
    expect(await scalar('SELECT name FROM products WHERE id = 3')).toBe('Monitor 27"');
  });

  it('computes order totals in the view', async () => {
    const totals = await rows<{ order_id: number; total: string }>(
      'SELECT order_id, total FROM order_totals ORDER BY order_id',
    );
    expect(totals.map((t) => [t.order_id, t.total])).toEqual([
      [1, '88.99'],
      [2, '329.00'],
      [3, '48.00'],
      [4, '120.49'],
      [5, '29.97'],
      [6, '677.50'],
      [7, '12.00'],
      [8, '93.75'],
    ]);
  });

  it('has the order_total function', async () => {
    expect(await scalar('SELECT order_total(6)')).toBe('677.50');
    expect(await scalar('SELECT order_total(999)')).toBe('0.00');
  });

  it('has the customer_orders procedure', async () => {
    const [result] = await conn.query<RowDataPacket[][]>('CALL customer_orders(?)', [3]);
    const [selected] = result;
    expect(selected?.map((row) => [row.id as number, row.status as string])).toEqual([
      [4, 'paid'],
      [5, 'cancelled'],
    ]);
  });

  it('rejects a non-positive quantity through the trigger', async () => {
    await expect(
      conn.query('INSERT INTO order_items VALUES (3, 1, 0, 49.99)'),
    ).rejects.toMatchObject({ sqlState: '45000', sqlMessage: 'quantity must be positive' });
    expect(Number(await scalar('SELECT COUNT(*) FROM order_items WHERE order_id = 3'))).toBe(1);
  });

  it('enforces foreign keys', async () => {
    await expect(
      conn.query("INSERT INTO orders (customer_id, ordered_at) VALUES (999, '2024-01-01')"),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
  });

  it('fills every column of all_types row 1 and none of row 2', async () => {
    const [full, empty] = await rows<Record<string, unknown>>(
      'SELECT * FROM all_types ORDER BY id',
    );
    expect(full).toMatchObject({
      c_tinyint: 127,
      c_smallint: 32767,
      c_int: 2147483647,
      c_bigint: '9223372036854775807',
      c_bigint_unsigned: '18446744073709551615',
      c_decimal: '12345678901234567890.0123456789',
      c_float: 1.5,
      c_double: 3.141592653589793,
      c_bool: 1,
      c_char: 'abc',
      c_varchar: 'O\'Brien "quoted" \\ backslash',
      c_text: 'Многострочный\nтекст 🚀',
      c_date: '2024-02-29',
      c_time: '23:59:59',
      c_datetime: '2024-12-31 23:59:59.123456',
      c_timestamp: '2024-06-15 12:00:00',
      c_year: 2024,
      c_enum: 'b',
      c_set: 'x,z',
    });
    expect(full?.c_bit).toEqual(Buffer.from([0b10100101]));
    expect(full?.c_binary).toEqual(Buffer.from('deadbeef', 'hex'));
    expect(full?.c_blob).toEqual(Buffer.from('00ff00ff', 'hex'));
    // MariaDB returns JSON as text, MySQL as a parsed object.
    const json: unknown = typeof full?.c_json === 'string' ? JSON.parse(full.c_json) : full?.c_json;
    expect(json).toEqual({ nested: { list: [1, 2, 3] }, unicode: '日本語' });

    expect(Object.values(full ?? {}).filter((value) => value === null)).toEqual([]);
    const { id, ...rest } = empty ?? {};
    expect(id).toBe(2);
    expect(Object.values(rest).every((value) => value === null)).toBe(true);
  });

  it('has an empty second database the test user can use', async () => {
    const count = await scalar(
      'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?',
      [db.emptyDatabase],
    );
    expect(Number(count)).toBe(0);
    await conn.query(`CREATE TABLE ${db.emptyDatabase}.probe (id INT)`);
    await conn.query(`DROP TABLE ${db.emptyDatabase}.probe`);
  });
});

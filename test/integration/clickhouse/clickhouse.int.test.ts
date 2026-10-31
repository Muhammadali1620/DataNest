import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/clickhouse';
import type { Session } from '../../../src/drivers/driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { CLICKHOUSE_HTTPS_PORT, testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { ROOT } from '../../helpers/repo';

// docker/compose.yml `clickhouse` (V6.3): ClickHouse 25.8 with docker/seed/clickhouse.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  const db = testDatabase('clickhouse');
  return {
    id: 'test-clickhouse',
    name: 'clickhouse',
    driver: 'clickhouse',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ...overrides,
  };
}

const CA = join(ROOT, 'docker', 'tls', 'ca.crt');
const OTHER_CA = join(ROOT, 'docker', 'tls', 'other-ca.crt');
const TABLE = { database: 'datanest_test', name: 'customers' };

describe('clickhouse driver', () => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config());
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS datanest_empty.ch_writes');
    await session.close();
  });

  it('runs a query and returns typed columns', async () => {
    const result = await runAll(session, 'SELECT id, email FROM customers ORDER BY id');
    expect(result.columnSets[0]).toEqual([
      { name: 'id', dataType: 'UInt32' },
      { name: 'email', dataType: 'String' },
    ]);
    expect(result.rows.map((row) => row[1])).toEqual([
      'alice@example.com',
      'bob@example.com',
      'olga@example.com',
      'hiro@example.com',
      'noname@example.com',
    ]);
  });

  it('keeps every value exact: 64- and 128-bit integers, decimals, dates, NaN', async () => {
    const result = await runAll(session, 'SELECT * FROM all_types WHERE id = 1');
    const names = (result.columnSets[0] ?? []).map((column) => column.name);
    const row = Object.fromEntries(names.map((name, index) => [name, result.rows[0]?.[index]]));
    expect(row).toMatchObject({
      c_int8: -128,
      c_uint8: 255,
      c_int32: 2147483647,
      c_int64: { kind: 'bigint', text: '9223372036854775807' },
      c_uint64: { kind: 'bigint', text: '18446744073709551615' },
      c_int128: { kind: 'bigint', text: '-170141183460469231731687303715884105728' },
      c_float32: 1.5,
      c_float64: 3.141592653589793,
      c_decimal: { kind: 'decimal', text: '12345678901234567890.0123456789' },
      c_bool: true,
      c_string: 'O\'Brien "quoted" \\ backslash\nline two',
      c_fixed: 'abc',
      c_low: 'low',
      c_date: { kind: 'datetime', text: '2024-02-29' },
      c_date32: { kind: 'datetime', text: '1900-01-01' },
      c_datetime: { kind: 'datetime', text: '2024-12-31 23:59:59' },
      c_datetime64: { kind: 'datetime', text: '2024-12-31 23:59:59.123456' },
      c_uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      c_ipv4: '192.168.0.1',
      c_enum: 'b',
      c_array: { kind: 'json', text: '[1,2,3]' },
      c_map: { kind: 'json', text: '{"one":1,"two":2}' },
      c_tuple: "('x', 7)",
    });
    expect(Number.isNaN(row.c_nan)).toBe(true);
  });

  it('returns NULL for nullable columns and defaults for the others', async () => {
    const result = await runAll(
      session,
      'SELECT c_int64, c_string, c_low, c_array FROM all_types WHERE id = 2',
    );
    expect(result.rows[0]).toEqual([null, null, '', { kind: 'json', text: '[]' }]);
  });

  it('streams a large result in batches, and stops at the row limit', async () => {
    const all = await runAll(session, 'SELECT id FROM big_table ORDER BY id');
    expect(all.rows).toHaveLength(10_000);
    expect(all.rows[9_999]).toEqual([10_000]);
    const limited = await runAll(session, 'SELECT id FROM big_table ORDER BY id', { rowLimit: 5 });
    expect(firstColumn(limited)).toEqual([1, 2, 3, 4, 5]);
    expect(firstColumn(await runAll(session, 'SELECT 7'))).toEqual([7]);
  });

  it('runs statements without rows, counting inserted rows', async () => {
    await runAll(session, 'DROP TABLE IF EXISTS datanest_empty.ch_writes');
    const create = await runAll(
      session,
      'CREATE TABLE datanest_empty.ch_writes (n UInt32, s String) ENGINE = MergeTree ORDER BY n',
    );
    expect(create.columnSets).toEqual([]);
    expect(create.done.affectedRows).toBeUndefined();
    const insert = await runAll(
      session,
      "INSERT INTO datanest_empty.ch_writes VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    );
    expect(insert.done.affectedRows).toBe(3);
    const copy = await runAll(
      session,
      'INSERT INTO datanest_empty.ch_writes SELECT number + 10, toString(number) FROM numbers(1000)',
    );
    expect(copy.done.affectedRows).toBe(1000);
    expect(
      firstColumn(await runAll(session, 'SELECT count() FROM datanest_empty.ch_writes')),
    ).toEqual([1003]);
  });

  it('keeps session state between statements: settings and USE', async () => {
    await runAll(session, 'SET max_threads = 3');
    expect(firstColumn(await runAll(session, "SELECT getSetting('max_threads')"))).toEqual([3]);
    await runAll(session, 'USE datanest_empty');
    expect(firstColumn(await runAll(session, 'SELECT currentDatabase()'))).toEqual([
      'datanest_empty',
    ]);
    await runAll(session, 'USE datanest_test');
  });

  it('shows a format the statement asks for as lines of text', async () => {
    const result = await runAll(
      session,
      'SELECT id, sku FROM products ORDER BY id LIMIT 2 FORMAT CSV',
    );
    expect(result.columnSets[0]).toEqual([{ name: 'CSV' }]);
    expect(result.rows).toEqual([['1,"SKU-001"'], ['2,"SKU-002"']]);
  });

  it('turns server errors into DbError codes, with the syntax error position', async () => {
    await expect(runAll(session, 'SELECT * FROM no_such_table')).rejects.toMatchObject({
      name: 'DbError',
      code: 'not-found',
      driverCode: 'UNKNOWN_TABLE',
    });
    await expect(runAll(session, 'SELECT 1\nSELEC 2')).rejects.toMatchObject({
      code: 'syntax',
      // `SELEC` reads as an alias of 1; the server stops at the 2 after it.
      position: 15,
    });
    await expect(runAll(session, "SELECT toInt32('x')")).rejects.toMatchObject({
      code: 'constraint',
    });
  });

  it('reports an error that comes after rows have started', async () => {
    const run = runAll(
      session,
      "SELECT throwIf(number = 5000, 'too far') FROM numbers(10000) SETTINGS max_block_size = 100",
    );
    await expect(run).rejects.toMatchObject({ code: 'constraint', message: /too far/u });
    expect(firstColumn(await runAll(session, 'SELECT 1'))).toEqual([1]);
  });

  it('cancels a running statement and stays usable', async () => {
    const run = runAll(
      session,
      'SELECT sleepEachRow(1) FROM numbers(30) SETTINGS max_block_size = 1',
    );
    const cancelled = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    await session.cancel();
    await cancelled;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(firstColumn(await runAll(session, 'SELECT 3'))).toEqual([3]);
  });

  it('reads the catalog while a statement runs', async () => {
    const [rows, tables] = await Promise.all([
      runAll(session, 'SELECT sleep(0.3), 5'),
      session.metadata.listTables({ database: 'datanest_test' }),
    ]);
    expect(firstColumn(rows)).toEqual([0]);
    expect(tables.map((table) => table.name)).toContain('customers');
  });

  it('has no transactions to report', () => {
    expect('transactionState' in session).toBe(false);
    expect(driver.capabilities.transactions).toBe(false);
  });

  describe('metadata', () => {
    it('lists databases, and tables and views without the inner tables of views', async () => {
      expect(await session.metadata.listDatabases()).toEqual(
        expect.arrayContaining(['datanest_empty', 'datanest_test', 'system']),
      );
      expect(await session.metadata.listSchemas()).toEqual([]);
      const tables = await session.metadata.listTables({ database: 'datanest_test' });
      expect(tables.map((table) => table.name)).toEqual([
        'all_types',
        'big_table',
        'customers',
        'order_items',
        'order_totals',
        'orders',
        'product_sales',
        'products',
      ]);
      expect(tables.find((table) => table.name === 'order_totals')).toEqual({
        name: 'order_totals',
        kind: 'view',
      });
      expect(tables.find((table) => table.name === 'product_sales')).toEqual({
        name: 'product_sales',
        kind: 'view',
        materialized: true,
      });
    });

    it('reads rows, bytes and the comment of tables (V10.2.3)', async () => {
      await runAll(session, 'DROP TABLE IF EXISTS datanest_test.stats_probe');
      await runAll(
        session,
        "CREATE TABLE datanest_test.stats_probe (id UInt32) ENGINE = MergeTree ORDER BY id COMMENT 'Probe of statistics'",
      );
      try {
        await runAll(session, 'INSERT INTO datanest_test.stats_probe VALUES (1), (2), (3)');
        const stats = (await session.metadata.tableStats?.({ database: 'datanest_test' })) ?? [];
        const probe = stats.find((entry) => entry.name === 'stats_probe');
        expect(probe).toMatchObject({ rows: 3, comment: 'Probe of statistics' });
        expect(probe?.bytes).toBeGreaterThan(0);
        expect(stats.find((entry) => entry.name === 'order_totals')?.rows).toBeUndefined();
        expect(stats.some((entry) => entry.name.startsWith('.inner'))).toBe(false);
      } finally {
        await runAll(session, 'DROP TABLE datanest_test.stats_probe');
      }
    });

    it('lists columns with nullability and defaults, but no key that identifies rows', async () => {
      const columns = await session.metadata.listColumns(TABLE);
      expect(columns).toEqual([
        { name: 'id', dataType: 'UInt32', nullable: false, primaryKey: false },
        { name: 'email', dataType: 'String', nullable: false, primaryKey: false },
        { name: 'full_name', dataType: 'Nullable(String)', nullable: true, primaryKey: false },
        {
          name: 'country',
          dataType: 'Nullable(FixedString(2))',
          nullable: true,
          primaryKey: false,
        },
        {
          name: 'created_at',
          dataType: 'DateTime',
          nullable: false,
          primaryKey: false,
          defaultValue: "'2024-01-01 00:00:00'",
        },
      ]);
      expect(await session.metadata.listUniqueKeys(TABLE)).toEqual([]);
      expect(await session.metadata.listForeignKeys(TABLE)).toEqual([]);
    });

    it('lists the sorting key and data skipping indexes', async () => {
      const products = await session.metadata.listIndexes({
        database: 'datanest_test',
        name: 'products',
      });
      expect(products).toEqual([
        { name: 'PRIMARY KEY', columns: ['id'], unique: false, primary: true },
        {
          name: 'ix_products_name',
          columns: ['name'],
          unique: false,
          primary: false,
          method: 'bloom_filter',
        },
      ]);
      const orders = await session.metadata.listIndexes({
        database: 'datanest_test',
        name: 'orders',
      });
      expect(orders[0]?.columns).toEqual(['customer_id', 'id']);
    });

    it('describes a table for the designer, nullability apart from the type', async () => {
      const structure = await session.metadata.describeTable(TABLE);
      expect(structure.comment).toBe('Shop customers');
      expect(structure.primaryKey).toEqual(['id']);
      expect(structure.columns[2]).toMatchObject({
        name: 'full_name',
        dataType: 'String',
        nullable: true,
      });
      const items = await session.metadata.describeTable({
        database: 'datanest_test',
        name: 'order_items',
      });
      expect(items.columns.find((column) => column.name === 'line_total')?.generated).toBe(true);
      const products = await session.metadata.describeTable({
        database: 'datanest_test',
        name: 'products',
      });
      expect(products.columns.find((column) => column.name === 'name')?.comment).toBe(
        'What the shop calls it',
      );
      await expect(
        session.metadata.describeTable({ database: 'datanest_test', name: 'order_totals' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('shows definitions as the server prints them, and dumps them without the database', async () => {
      const [table] = await session.metadata.getDefinition({ kind: 'table', ...TABLE });
      expect(table).toMatch(/^CREATE TABLE customers\n\(/u);
      expect(table).toContain('ENGINE = MergeTree');
      const [view] = await session.metadata.getDefinition({
        kind: 'view',
        database: 'datanest_test',
        name: 'order_totals',
      });
      expect(view).toMatch(/^CREATE VIEW order_totals/u);
      expect(view).toContain('FROM datanest_test.orders');
      const dump = await session.metadata.getTableDump(TABLE);
      expect(dump.create[0]).toMatch(/^CREATE TABLE customers\n\(/u);
      await expect(
        session.metadata.getDefinition({ kind: 'table', database: 'datanest_test', name: 'nope' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('connecting', () => {
    it('refuses a wrong password', async () => {
      await expect(driver.openSession(config({ password: 'wrong' }))).rejects.toMatchObject({
        code: 'auth-failed',
      });
    });

    it('says when the database does not exist', async () => {
      await expect(driver.openSession(config({ database: 'no_such_db' }))).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('fails clearly when nothing listens on the port', async () => {
      await expect(
        driver.openSession(config({ port: 7998, options: { connectTimeout: 3 } })),
      ).rejects.toMatchObject({ code: 'connection-failed' });
    });

    it('refuses writes on a read-only connection, in the server', async () => {
      const readOnly = await driver.openSession(config({ readOnly: true }));
      try {
        expect(firstColumn(await runAll(readOnly, 'SELECT count() FROM customers'))).toEqual([5]);
        await expect(
          runAll(readOnly, "INSERT INTO customers (id, email) VALUES (99, 'x')"),
        ).rejects.toMatchObject({ code: 'permission-denied' });
      } finally {
        await readOnly.close();
      }
    });

    it('closes twice without trouble', async () => {
      const extra = await driver.openSession(config());
      await extra.close();
      await extra.close();
      await expect(runAll(extra, 'SELECT 1')).rejects.toMatchObject({ code: 'internal' });
    });
  });

  describe('TLS', () => {
    const https = (
      ssl: ResolvedConnectionConfig['ssl'],
      extra: Partial<ResolvedConnectionConfig> = {},
    ) => config({ port: CLICKHOUSE_HTTPS_PORT, ...(ssl === undefined ? {} : { ssl }), ...extra });

    it('connects over HTTPS with each mode, and checks what each mode checks', async () => {
      for (const ssl of [
        { mode: 'require' as const },
        { mode: 'verify-ca' as const, ca: CA },
        { mode: 'verify-full' as const, ca: CA },
      ]) {
        const tls = await driver.openSession(https(ssl));
        try {
          expect(firstColumn(await runAll(tls, 'SELECT 1'))).toEqual([1]);
        } finally {
          await tls.close();
        }
      }
      const anyName = await driver.openSession(
        https({ mode: 'verify-ca', ca: CA }, { tlsServerName: 'not-covered.example' }),
      );
      await anyName.close();
      await expect(
        driver.openSession(https({ mode: 'verify-ca', ca: OTHER_CA })),
      ).rejects.toMatchObject({
        code: 'connection-failed',
        message: /not trusted/u,
      });
      await expect(
        driver.openSession(
          https({ mode: 'verify-full', ca: CA }, { tlsServerName: 'not-covered.example' }),
        ),
      ).rejects.toMatchObject({ code: 'connection-failed', message: /not-covered\.example/u });
    });
  });
});

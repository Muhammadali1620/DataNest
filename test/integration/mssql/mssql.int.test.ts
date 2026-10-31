import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/mssql';
import type { Session } from '../../../src/drivers/driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { ROOT } from '../../helpers/repo';

// docker/compose.yml `mssql` (V6.2): SQL Server 2022 with docker/seed/mssql.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  const db = testDatabase('mssql');
  return {
    id: 'test-mssql',
    name: 'mssql',
    driver: 'mssql',
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

describe('mssql driver', () => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config());
  });

  afterAll(async () => {
    await session.close();
  });

  it('runs a query and returns typed columns', async () => {
    const result = await runAll(session, 'SELECT id, email FROM customers ORDER BY id');
    expect(result.columnSets[0]).toEqual([
      { name: 'id', dataType: 'int' },
      { name: 'email', dataType: 'nvarchar' },
    ]);
    expect(result.rows.map((row) => row[1])).toEqual([
      'alice@example.com',
      'bob@example.com',
      'olga@example.com',
      'hiro@example.com',
      'noname@example.com',
    ]);
  });

  it('keeps every value exact: decimals, money, dates with fractions and offsets', async () => {
    const result = await runAll(session, 'SELECT * FROM all_types WHERE id = 1');
    const names = (result.columnSets[0] ?? []).map((column) => column.name);
    const row = Object.fromEntries(names.map((name, index) => [name, result.rows[0]?.[index]]));
    expect(row).toMatchObject({
      c_tinyint: 255,
      c_smallint: 32767,
      c_int: 2147483647,
      c_bigint: { kind: 'bigint', text: '9223372036854775807' },
      c_decimal: { kind: 'decimal', text: '12345678901234567890.0123456789' },
      c_numeric: { kind: 'decimal', text: '12345678901234567890123456789012345678' },
      c_money: { kind: 'decimal', text: '922337203685477.5807' },
      c_smallmoney: { kind: 'decimal', text: '-214748.3648' },
      c_real: 1.5,
      c_float: 3.141592653589793,
      c_bit: true,
      c_char: 'abc',
      c_varchar: 'O\'Brien "quoted" \\ backslash',
      c_nchar: 'äöü',
      c_nvarchar: 'Многострочный\nтекст 🚀',
      c_date: { kind: 'datetime', text: '2024-02-29' },
      c_time: { kind: 'datetime', text: '23:59:59.1234567' },
      c_datetime: { kind: 'datetime', text: '2024-12-31 23:59:59.997' },
      c_smalldatetime: { kind: 'datetime', text: '2024-12-31 23:59:00' },
      c_datetime2: { kind: 'datetime', text: '2024-12-31 23:59:59.1234567' },
      c_datetimeoffset: { kind: 'datetime', text: '2024-06-15 12:00:00.1234567 +03:00' },
      c_uniqueidentifier: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
      c_binary: { kind: 'binary', size: 4, preview: 'deadbeef' },
      c_varbinary: { kind: 'binary', size: 5, preview: 'cafebabe00' },
      c_xml: '<root><item id="1">日本語</item></root>',
    });
  });

  it('returns NULL for every type in an empty row', async () => {
    const result = await runAll(session, 'SELECT * FROM all_types WHERE id = 2');
    expect(result.rows[0]?.slice(1).every((value) => value === null)).toBe(true);
  });

  it('decodes values the server computes, across the edges of each type', async () => {
    const result = await runAll(
      session,
      `SELECT CAST(-0.5 AS decimal(5, 2)), CAST(0 AS decimal(9, 4)), CAST(-1 AS money),
              CAST('0001-01-01' AS date), CAST('9999-12-31 23:59:59.9999999' AS datetime2),
              CAST('2024-01-01 00:30:00 -05:30' AS datetimeoffset(0)),
              CAST('1753-01-01 00:00:00' AS datetime), CAST('12:00' AS time(0)),
              CAST(-9223372036854775808 AS bigint), CAST(42 AS bigint)`,
    );
    expect(result.rows[0]).toEqual([
      { kind: 'decimal', text: '-0.50' },
      { kind: 'decimal', text: '0.0000' },
      { kind: 'decimal', text: '-1.0000' },
      { kind: 'datetime', text: '0001-01-01' },
      { kind: 'datetime', text: '9999-12-31 23:59:59.9999999' },
      { kind: 'datetime', text: '2024-01-01 00:30:00 -05:30' },
      { kind: 'datetime', text: '1753-01-01 00:00:00.000' },
      { kind: 'datetime', text: '12:00:00' },
      { kind: 'bigint', text: '-9223372036854775808' },
      42,
    ]);
  });

  it('streams a large result in batches', async () => {
    const result = await runAll(session, 'SELECT id FROM big_table ORDER BY id');
    expect(result.rows).toHaveLength(10_000);
    expect(result.rows[9_999]).toEqual([10_000]);
  });

  it('stops at the row limit and stays usable', async () => {
    const result = await runAll(session, 'SELECT id FROM big_table ORDER BY id', { rowLimit: 5 });
    expect(firstColumn(result)).toEqual([1, 2, 3, 4, 5]);
    expect(firstColumn(await runAll(session, 'SELECT 7'))).toEqual([7]);
  });

  it('reports affected rows of a write, and none for a SELECT', async () => {
    await runAll(session, 'CREATE TABLE #affected (n INT)');
    const insert = await runAll(session, 'INSERT INTO #affected VALUES (1), (2), (3)');
    expect(insert.done.affectedRows).toBe(3);
    const update = await runAll(session, 'UPDATE #affected SET n = n + 1 WHERE n > 1');
    expect(update.done.affectedRows).toBe(2);
    const select = await runAll(session, 'SELECT n FROM #affected');
    expect(select.done.affectedRows).toBeUndefined();
    await runAll(session, 'DROP TABLE #affected');
  });

  it('passes on what PRINT says as a notice', async () => {
    const result = await runAll(session, "PRINT 'hello from the server'");
    expect(result.done.notice).toBe('hello from the server');
  });

  it('runs a whole batch, a procedure body included, and every result set arrives', async () => {
    const result = await runAll(session, 'SELECT 1 AS a\nSELECT 2 AS b');
    expect(result.columnSets).toEqual([
      [{ name: 'a', dataType: 'int' }],
      [{ name: 'b', dataType: 'int' }],
    ]);
    const proc = await runAll(session, 'EXEC customer_orders 1');
    expect(proc.rows).toEqual([
      [1, 'paid'],
      [2, 'shipped'],
    ]);
  });

  it('keeps variables within one batch', async () => {
    const result = await runAll(session, 'DECLARE @n INT = 41;\nSELECT @n + 1;');
    expect(firstColumn(result)).toEqual([42]);
  });

  it('names unnamed columns', async () => {
    const result = await runAll(session, 'SELECT 1, 2');
    expect(result.columnSets[0]?.map((column) => column.name)).toEqual(['column1', 'column2']);
  });

  it('turns server errors into DbError codes, with the line as a position', async () => {
    await expect(runAll(session, 'SELECT * FROM no_such_table')).rejects.toMatchObject({
      name: 'DbError',
      code: 'not-found',
      driverCode: 208,
    });
    const syntax = runAll(session, 'SELECT 1\nSELEC 2 FROM x');
    await expect(syntax).rejects.toMatchObject({ code: 'syntax', position: 9 });
    await expect(
      runAll(session, "INSERT INTO customers (email) VALUES (N'alice@example.com')"),
    ).rejects.toMatchObject({ code: 'constraint', driverCode: 2627 });
    await expect(runAll(session, 'SELECT 1 / 0')).rejects.toMatchObject({ code: 'constraint' });
  });

  it('reports a trigger THROW as a constraint, with the procedure it came from', async () => {
    const error = await runAll(
      session,
      'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (3, 1, 0, 1)',
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'constraint', driverCode: 50001 });
    expect((error as { detail?: string }).detail).toMatch(/order_items_quantity_check/u);
  });

  it('cancels a running statement and stays usable', async () => {
    const run = runAll(session, "WAITFOR DELAY '00:00:20'");
    const cancelled = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await session.cancel();
    await cancelled;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(firstColumn(await runAll(session, 'SELECT 3'))).toEqual([3]);
  });

  it('cancels the rest when the reader stops early', async () => {
    for await (const event of session.execute('SELECT id FROM big_table ORDER BY id')) {
      if (event.kind === 'rows') {
        break;
      }
    }
    expect(firstColumn(await runAll(session, 'SELECT 4'))).toEqual([4]);
  });

  it('queues catalog reads behind a running statement instead of failing', async () => {
    const [rows, tables] = await Promise.all([
      runAll(session, "WAITFOR DELAY '00:00:00.300'; SELECT 5"),
      session.metadata.listTables({ schema: 'dbo' }),
    ]);
    expect(firstColumn(rows)).toEqual([5]);
    expect(tables.map((table) => table.name)).toContain('customers');
  });

  it('tells the transaction state as the server reports it', async () => {
    expect(session.transactionState?.()).toBe('idle');
    await runAll(session, 'BEGIN TRANSACTION');
    expect(session.transactionState?.()).toBe('open');
    await runAll(session, 'SELECT 1');
    expect(session.transactionState?.()).toBe('open');
    await runAll(session, 'ROLLBACK');
    expect(session.transactionState?.()).toBe('idle');
  });

  describe('metadata', () => {
    it('lists the databases this login may open', async () => {
      const databases = await session.metadata.listDatabases();
      expect(databases).toEqual(
        expect.arrayContaining(['datanest_empty', 'datanest_test', 'master']),
      );
    });

    it('lists schemas with dbo first and without the role schemas', async () => {
      const schemas = await session.metadata.listSchemas();
      expect(schemas[0]).toBe('dbo');
      expect(schemas).toContain('inventory');
      expect(schemas).not.toContain('db_owner');
    });

    it('lists tables and views of a schema', async () => {
      const tables = await session.metadata.listTables({ schema: 'dbo' });
      expect(tables).toEqual(
        expect.arrayContaining([
          { name: 'customers', kind: 'table' },
          { name: 'order_totals', kind: 'view' },
        ]),
      );
      const inventory = await session.metadata.listTables({ schema: 'inventory' });
      expect(inventory.map((table) => table.name)).toEqual(['stock_levels', 'warehouses']);
    });

    it('reads rows, space and description from the catalog (V10.2.3)', async () => {
      await runAll(session, 'DROP TABLE IF EXISTS dbo.stats_probe');
      await runAll(session, 'CREATE TABLE dbo.stats_probe (id int PRIMARY KEY)');
      try {
        await runAll(session, 'INSERT INTO dbo.stats_probe VALUES (1), (2), (3)');
        await runAll(
          session,
          "EXEC sp_addextendedproperty 'MS_Description', N'Probe of statistics', 'SCHEMA', 'dbo', 'TABLE', 'stats_probe'",
        );
        const stats = (await session.metadata.tableStats?.({ schema: 'dbo' })) ?? [];
        const probe = stats.find((entry) => entry.name === 'stats_probe');
        expect(probe).toMatchObject({ rows: 3, comment: 'Probe of statistics' });
        expect(probe?.bytes).toBeGreaterThan(0);
        expect(stats.find((entry) => entry.name === 'order_totals')).toEqual({
          name: 'order_totals',
        });
      } finally {
        await runAll(session, 'DROP TABLE dbo.stats_probe');
      }
    });

    it('lists columns with DDL types, keys and unwrapped defaults', async () => {
      const columns = await session.metadata.listColumns({ schema: 'dbo', name: 'products' });
      expect(columns).toEqual([
        { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
        { name: 'sku', dataType: 'varchar(32)', nullable: false, primaryKey: false },
        { name: 'name', dataType: 'nvarchar(255)', nullable: false, primaryKey: false },
        { name: 'price', dataType: 'decimal(10,2)', nullable: false, primaryKey: false },
        { name: 'stock', dataType: 'int', nullable: false, primaryKey: false, defaultValue: '0' },
        {
          name: 'is_active',
          dataType: 'bit',
          nullable: false,
          primaryKey: false,
          defaultValue: '1',
        },
        { name: 'attributes', dataType: 'nvarchar(max)', nullable: true, primaryKey: false },
      ]);
    });

    it('lists unique keys, foreign keys and indexes', async () => {
      expect(await session.metadata.listUniqueKeys({ schema: 'dbo', name: 'customers' })).toEqual([
        ['email'],
      ]);
      const keys = await session.metadata.listForeignKeys({ schema: 'dbo', name: 'order_items' });
      expect(keys.map((key) => [key.columns, key.target.name, key.onDelete])).toEqual(
        expect.arrayContaining([
          [['order_id'], 'orders', 'CASCADE'],
          [['product_id'], 'products', 'NO ACTION'],
        ]),
      );
      const crossSchema = await session.metadata.listForeignKeys({
        schema: 'inventory',
        name: 'stock_levels',
      });
      expect(crossSchema.find((key) => key.target.name === 'products')?.target.schema).toBe('dbo');
      const indexes = await session.metadata.listIndexes({ schema: 'dbo', name: 'products' });
      expect(indexes[0]).toMatchObject({ primary: true, columns: ['id'], method: 'CLUSTERED' });
      expect(indexes).toContainEqual(
        expect.objectContaining({ name: 'ix_products_name', columns: ['name'], unique: false }),
      );
    });

    it('lists routines, triggers and sequences', async () => {
      const scope = { schema: 'dbo' };
      expect(await session.metadata.listObjects(scope, 'function')).toEqual([
        { name: 'order_total', kind: 'function' },
      ]);
      expect((await session.metadata.listObjects(scope, 'procedure')).map((o) => o.name)).toEqual([
        'customer_orders',
        'restock',
      ]);
      expect(await session.metadata.listObjects(scope, 'trigger')).toEqual([
        { name: 'order_items_quantity_check', kind: 'trigger', table: 'order_items' },
      ]);
      expect(await session.metadata.listObjects(scope, 'sequence')).toEqual([
        { name: 'invoice_number_seq', kind: 'sequence' },
      ]);
      expect(await session.metadata.listObjects(scope, 'event')).toEqual([]);
    });

    it('describes a table for the designer', async () => {
      const structure = await session.metadata.describeTable({ schema: 'dbo', name: 'customers' });
      expect(structure.comment).toBe('Shop customers');
      expect(structure.primaryKey).toEqual(['id']);
      expect(structure.primaryKeyName).toMatch(/^PK__customer/u);
      expect(structure.columns[0]).toMatchObject({
        name: 'id',
        autoIncrement: true,
        generated: false,
      });
      expect(structure.columns.find((c) => c.name === 'created_at')).toMatchObject({
        dataType: 'datetime2(0)',
        defaultExpression: "'2024-01-01 00:00:00'",
      });
      await expect(
        session.metadata.describeTable({ schema: 'dbo', name: 'no_such' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('builds a table definition that leaves out names the server made up', async () => {
      const statements = await session.metadata.getDefinition({
        kind: 'table',
        schema: 'dbo',
        name: 'orders',
      });
      const create = statements[0] ?? '';
      expect(create).toMatch(/^CREATE TABLE \[dbo\]\.\[orders\] \(/u);
      expect(create).toContain('[id] int IDENTITY(1, 1) NOT NULL');
      expect(create).toContain("[status] varchar(16) NOT NULL DEFAULT ('new')");
      expect(create).toContain('PRIMARY KEY CLUSTERED ([id])');
      expect(create).not.toContain('CONSTRAINT [PK__');
      expect(statements).toContain(
        'CREATE NONCLUSTERED INDEX [ix_orders_customer] ON [dbo].[orders] ([customer_id])',
      );
      expect(
        statements.some((sql) => sql.startsWith('ALTER TABLE [dbo].[orders] ADD FOREIGN KEY')),
      ).toBe(true);
    });

    it('reads views, routines, triggers and sequences as written', async () => {
      const scope = { schema: 'dbo' };
      const [view] = await session.metadata.getDefinition({
        ...scope,
        kind: 'view',
        name: 'order_totals',
      });
      expect(view).toMatch(/^CREATE VIEW order_totals AS/u);
      const [proc] = await session.metadata.getDefinition({
        ...scope,
        kind: 'procedure',
        name: 'restock',
      });
      expect(proc).toMatch(/^CREATE PROCEDURE restock @product_id INT/u);
      const [trigger] = await session.metadata.getDefinition({
        ...scope,
        kind: 'trigger',
        name: 'order_items_quantity_check',
        table: 'order_items',
      });
      expect(trigger).toContain('THROW 50001');
      const [sequence] = await session.metadata.getDefinition({
        ...scope,
        kind: 'sequence',
        name: 'invoice_number_seq',
      });
      expect(sequence).toBe(
        'CREATE SEQUENCE [dbo].[invoice_number_seq] AS bigint START WITH 1000 INCREMENT BY 1 MINVALUE -9223372036854775808 MAXVALUE 9223372036854775807 NO CYCLE CACHE',
      );
      await expect(
        session.metadata.getDefinition({ ...scope, kind: 'view', name: 'nope' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('splits a table for a dump: keys and triggers after the rows', async () => {
      const dump = await session.metadata.getTableDump({ schema: 'dbo', name: 'order_items' });
      expect(dump.before).toEqual([]);
      expect(dump.create[0]).toMatch(/^CREATE TABLE \[dbo\]\.\[order_items\]/u);
      expect(dump.create.join('\n')).not.toContain('FOREIGN KEY');
      expect(dump.after.filter((sql) => sql.includes('FOREIGN KEY'))).toHaveLength(2);
      expect(dump.after.at(-1)).toMatch(/^CREATE TRIGGER order_items_quantity_check/u);
      expect(dump.owns).toEqual([
        {
          kind: 'trigger',
          schema: 'dbo',
          name: 'order_items_quantity_check',
          table: 'order_items',
        },
      ]);
    });
  });

  describe('connecting', () => {
    it('opens another database of the server', async () => {
      const other = await driver.openSession(config({ database: 'datanest_empty' }));
      try {
        expect(firstColumn(await runAll(other, 'SELECT DB_NAME()'))).toEqual(['datanest_empty']);
        expect(await other.metadata.listTables({ schema: 'dbo' })).toEqual([]);
      } finally {
        await other.close();
      }
    });

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

    it('closes twice without trouble', async () => {
      const extra = await driver.openSession(config());
      await extra.close();
      await extra.close();
      await expect(runAll(extra, 'SELECT 1')).rejects.toMatchObject({ code: 'internal' });
    });
  });

  describe('TLS', () => {
    const encrypted = async (target: Session): Promise<unknown> =>
      firstColumn(
        await runAll(
          target,
          'SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID',
        ),
      )[0];

    it('encrypts with require, trusting any certificate', async () => {
      const tls = await driver.openSession(config({ ssl: { mode: 'require' } }));
      try {
        expect(await encrypted(tls)).toBe('TRUE');
      } finally {
        await tls.close();
      }
    });

    it('checks the chain with verify-ca, whatever name the certificate has', async () => {
      const tls = await driver.openSession(
        config({ ssl: { mode: 'verify-ca', ca: CA }, tlsServerName: 'not-covered.example' }),
      );
      try {
        expect(await encrypted(tls)).toBe('TRUE');
      } finally {
        await tls.close();
      }
      await expect(
        driver.openSession(config({ ssl: { mode: 'verify-ca', ca: OTHER_CA } })),
      ).rejects.toMatchObject({ code: 'connection-failed', message: /not trusted/u });
    });

    it('checks the name too with verify-full', async () => {
      const tls = await driver.openSession(config({ ssl: { mode: 'verify-full', ca: CA } }));
      try {
        expect(await encrypted(tls)).toBe('TRUE');
      } finally {
        await tls.close();
      }
      await expect(
        driver.openSession(
          config({ ssl: { mode: 'verify-full', ca: CA }, tlsServerName: 'not-covered.example' }),
        ),
      ).rejects.toMatchObject({ code: 'connection-failed', message: /not-covered\.example/u });
    });

    it('sends only the login encrypted without TLS settings', async () => {
      expect(await encrypted(session)).toBe('FALSE');
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/oracle';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { ORACLE_SERVICE, testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';

// docker/compose.yml `oracle` (V6.4): Oracle Database 23ai Free with docker/seed/oracle.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  const db = testDatabase('oracle');
  return {
    id: 'test-oracle',
    name: 'oracle',
    driver: 'oracle',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: ORACLE_SERVICE,
    ...overrides,
  };
}

const SCHEMA = 'DATANEST';

describe('oracle driver', () => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config());
  });

  afterAll(async () => {
    await runAll(
      session,
      "BEGIN EXECUTE IMMEDIATE 'DROP TABLE ora_writes'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    );
    await session.close();
  });

  it('runs a query and returns typed columns', async () => {
    const result = await runAll(session, 'SELECT id, email FROM customers ORDER BY id');
    expect(result.columnSets[0]).toEqual([
      { name: 'ID', dataType: 'NUMBER(10)' },
      { name: 'EMAIL', dataType: 'VARCHAR2' },
    ]);
    expect(firstColumn(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps every value exact: NUMBER(38), fractions, offsets, intervals, LOBs', async () => {
    const result = await runAll(session, 'SELECT * FROM all_types WHERE id = 1');
    const names = (result.columnSets[0] ?? []).map((column) => column.name);
    const row = Object.fromEntries(names.map((name, index) => [name, result.rows[0]?.[index]]));
    expect(row).toEqual({
      ID: 1,
      C_NUMBER: { kind: 'decimal', text: '1234567890123456789012345678.0123456789' },
      C_INTEGER: { kind: 'bigint', text: '12345678901234567890123456789012345678' },
      C_PLAIN: { kind: 'decimal', text: '3.14159265358979323846264338327950288' },
      C_FLOAT: 1.5,
      C_DOUBLE: 3.141592653589793,
      C_BOOL: true,
      C_CHAR: 'abc',
      C_VARCHAR: 'O\'Brien "quoted" \\ backslash',
      C_NVARCHAR: 'äöü 日本語',
      C_CLOB: 'Многострочный\nтекст',
      C_DATE: { kind: 'datetime', text: '2024-02-29 00:00:00' },
      C_TIMESTAMP: { kind: 'datetime', text: '2024-12-31 23:59:59.123456' },
      C_TIMESTAMP_TZ: { kind: 'datetime', text: '2024-06-15 12:00:00.123456 +03:00' },
      C_INTERVAL_YM: '+01-02',
      C_INTERVAL_DS: '+03 04:05:06.789000',
      C_RAW: { kind: 'binary', size: 4, preview: 'deadbeef' },
      C_BLOB: { kind: 'binary', size: 5, preview: 'cafebabe00' },
      C_JSON: { kind: 'json', text: '{"nested":{"list":[1,2,3]},"unicode":"日本語"}' },
    });
  });

  it('decodes dates across the edges, whatever the local time zone', async () => {
    const result = await runAll(
      session,
      `SELECT DATE '0001-01-01', TIMESTAMP '9999-12-31 23:59:59.999999999',
              CAST(TIMESTAMP '2024-01-01 00:30:00 -05:30' AS TIMESTAMP(0) WITH TIME ZONE),
              -0.5, 0, 1e-130 FROM dual`,
    );
    expect(result.rows[0]).toEqual([
      { kind: 'datetime', text: '0001-01-01 00:00:00' },
      { kind: 'datetime', text: '9999-12-31 23:59:59.999999999' },
      { kind: 'datetime', text: '2024-01-01 00:30:00 -05:30' },
      { kind: 'decimal', text: '-0.5' },
      0,
      // The smallest NUMBER, written out in full rather than rounded to a double.
      { kind: 'decimal', text: `0.${'0'.repeat(129)}1` },
    ]);
  });

  it('returns NULL for every type in an empty row', async () => {
    const result = await runAll(session, 'SELECT * FROM all_types WHERE id = 2');
    expect(result.rows[0]?.slice(1).every((value) => value === null)).toBe(true);
  });

  it('streams a large result, and stops at the row limit', async () => {
    const all = await runAll(session, 'SELECT id FROM big_table ORDER BY id');
    expect(all.rows).toHaveLength(10_000);
    const limited = await runAll(session, 'SELECT id FROM big_table ORDER BY id', { rowLimit: 5 });
    expect(firstColumn(limited)).toEqual([1, 2, 3, 4, 5]);
    expect(firstColumn(await runAll(session, 'SELECT 7 FROM dual'))).toEqual([7]);
  });

  it('commits each change by itself, and counts rows', async () => {
    await runAll(session, 'CREATE TABLE ora_writes (n NUMBER)');
    const insert = await runAll(
      session,
      'INSERT INTO ora_writes SELECT LEVEL FROM dual CONNECT BY LEVEL <= 3',
    );
    expect(insert.done.affectedRows).toBe(3);
    expect(session.transactionState?.()).toBe('idle');
    const other = await driver.openSession(config());
    try {
      expect(firstColumn(await runAll(other, 'SELECT COUNT(*) FROM ora_writes'))).toEqual([3]);
    } finally {
      await other.close();
    }
  });

  it('holds changes in a transaction begun on purpose, until COMMIT or ROLLBACK', async () => {
    await runAll(session, 'SET TRANSACTION READ WRITE');
    await runAll(session, 'DELETE FROM ora_writes');
    expect(session.transactionState?.()).toBe('open');
    await runAll(session, 'ROLLBACK');
    expect(session.transactionState?.()).toBe('idle');
    expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM ora_writes'))).toEqual([3]);
  });

  it('runs PL/SQL and passes on what DBMS_OUTPUT printed', async () => {
    const block = await runAll(
      session,
      "BEGIN DBMS_OUTPUT.PUT_LINE('hello'); DBMS_OUTPUT.PUT_LINE('from PL/SQL'); END;",
    );
    expect(block.done.notice).toBe('hello\nfrom PL/SQL');
    expect(firstColumn(await runAll(session, 'SELECT order_total(1) FROM dual'))).toEqual([
      { kind: 'decimal', text: '88.99' },
    ]);
  });

  it("reports a routine that does not compile, with the compiler's words", async () => {
    const run = runAll(
      session,
      'CREATE OR REPLACE PROCEDURE ora_broken AS BEGIN no_such_thing; END;',
    );
    await expect(run).rejects.toMatchObject({ code: 'syntax', message: /line \d+, column \d+/u });
    await runAll(session, 'DROP PROCEDURE ora_broken');
  });

  it('turns server errors into DbError codes, with the position', async () => {
    await expect(runAll(session, 'SELECT * FROM no_such_table')).rejects.toMatchObject({
      code: 'not-found',
      driverCode: 'ORA-00942',
      position: 14,
    });
    await expect(runAll(session, 'SELECT 1 FROM dual WHERE')).rejects.toMatchObject({
      code: 'syntax',
    });
    await expect(
      runAll(session, "INSERT INTO customers (email) VALUES ('alice@example.com')"),
    ).rejects.toMatchObject({ code: 'constraint', driverCode: 'ORA-00001' });
    await expect(
      runAll(session, 'INSERT INTO order_items VALUES (3, 1, 0, 1)'),
    ).rejects.toMatchObject({ code: 'constraint', driverCode: 'ORA-20001' });
  });

  it('cancels a running statement and stays usable', async () => {
    // A heavy query: DBMS_SESSION.SLEEP does not notice a break until it wakes up.
    const run = runAll(session, 'SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c');
    const cancelled = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    await session.cancel();
    await cancelled;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(firstColumn(await runAll(session, 'SELECT 3 FROM dual'))).toEqual([3]);
  });

  describe('metadata', () => {
    it('shows the service as the database and the users as schemas', async () => {
      expect(await session.metadata.listDatabases()).toEqual([ORACLE_SERVICE]);
      const schemas = await session.metadata.listSchemas();
      expect(schemas[0]).toBe(SCHEMA);
      expect(schemas).toEqual(expect.arrayContaining(['INVENTORY', 'DATANEST_EMPTY']));
      expect(schemas).not.toContain('SYS');
    });

    it('lists tables and views of a schema', async () => {
      const tables = await session.metadata.listTables({ schema: SCHEMA });
      expect(tables).toEqual(
        expect.arrayContaining([
          { name: 'CUSTOMERS', kind: 'table' },
          { name: 'ORDER_TOTALS', kind: 'view' },
        ]),
      );
      expect(
        (await session.metadata.listTables({ schema: 'INVENTORY' })).map((t) => t.name),
      ).toEqual(['STOCK_LEVELS', 'WAREHOUSES']);
    });

    it('lists columns with DDL types, keys and defaults, no sequence for identity columns', async () => {
      expect(await session.metadata.listColumns({ schema: SCHEMA, name: 'PRODUCTS' })).toEqual([
        { name: 'ID', dataType: 'NUMBER(10)', nullable: false, primaryKey: true },
        { name: 'SKU', dataType: 'VARCHAR2(32 BYTE)', nullable: false, primaryKey: false },
        { name: 'NAME', dataType: 'NVARCHAR2(255)', nullable: false, primaryKey: false },
        { name: 'PRICE', dataType: 'NUMBER(10,2)', nullable: false, primaryKey: false },
        {
          name: 'STOCK',
          dataType: 'NUMBER(10)',
          nullable: false,
          primaryKey: false,
          defaultValue: '0',
        },
        {
          name: 'IS_ACTIVE',
          dataType: 'BOOLEAN',
          nullable: false,
          primaryKey: false,
          defaultValue: 'TRUE',
        },
        { name: 'ATTRIBUTES', dataType: 'JSON', nullable: true, primaryKey: false },
      ]);
    });

    it('lists unique keys, foreign keys across schemas and indexes', async () => {
      expect(await session.metadata.listUniqueKeys({ schema: SCHEMA, name: 'CUSTOMERS' })).toEqual([
        ['EMAIL'],
      ]);
      const keys = await session.metadata.listForeignKeys({ schema: SCHEMA, name: 'ORDER_ITEMS' });
      expect(keys.map((key) => [key.columns, key.target.name, key.onDelete])).toEqual(
        expect.arrayContaining([
          [['ORDER_ID'], 'ORDERS', 'CASCADE'],
          [['PRODUCT_ID'], 'PRODUCTS', 'NO ACTION'],
        ]),
      );
      const crossSchema = await session.metadata.listForeignKeys({
        schema: 'INVENTORY',
        name: 'STOCK_LEVELS',
      });
      expect(crossSchema.find((key) => key.target.name === 'PRODUCTS')?.target.schema).toBe(SCHEMA);
      const indexes = await session.metadata.listIndexes({ schema: SCHEMA, name: 'PRODUCTS' });
      expect(indexes[0]).toMatchObject({ primary: true, columns: ['ID'] });
      expect(indexes).toContainEqual(
        expect.objectContaining({ name: 'IX_PRODUCTS_NAME', columns: ['NAME'], unique: false }),
      );
    });

    it('lists routines, triggers and sequences without identity sequences', async () => {
      const scope = { schema: SCHEMA };
      expect(await session.metadata.listObjects(scope, 'function')).toEqual([
        { name: 'ORDER_TOTAL', kind: 'function' },
      ]);
      expect(await session.metadata.listObjects(scope, 'procedure')).toEqual([
        { name: 'RESTOCK', kind: 'procedure' },
      ]);
      expect(await session.metadata.listObjects(scope, 'trigger')).toEqual([
        { name: 'ORDER_ITEMS_QUANTITY_CHECK', kind: 'trigger', table: 'ORDER_ITEMS' },
      ]);
      expect(await session.metadata.listObjects(scope, 'sequence')).toEqual([
        { name: 'INVOICE_NUMBER_SEQ', kind: 'sequence' },
      ]);
    });

    it('describes a table for the designer', async () => {
      const structure = await session.metadata.describeTable({ schema: SCHEMA, name: 'CUSTOMERS' });
      expect(structure.comment).toBe('Shop customers');
      expect(structure.primaryKey).toEqual(['ID']);
      expect(structure.columns[0]).toMatchObject({ name: 'ID', autoIncrement: true });
      expect(structure.columns[0]?.defaultExpression).toBeUndefined();
      const products = await session.metadata.describeTable({ schema: SCHEMA, name: 'PRODUCTS' });
      expect(products.columns.find((c) => c.name === 'NAME')?.comment).toBe(
        'What the shop calls it',
      );
      await expect(
        session.metadata.describeTable({ schema: SCHEMA, name: 'NOPE' }),
      ).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('reads definitions without storage clauses, and splits a table for a dump', async () => {
      const table = await session.metadata.getDefinition({
        kind: 'table',
        schema: SCHEMA,
        name: 'ORDERS',
      });
      expect(table[0]).toMatch(/^CREATE TABLE "DATANEST"\."ORDERS"/u);
      expect(table.join('\n')).not.toMatch(/TABLESPACE|PCTFREE|STORAGE\s*\(/u);
      expect(table.some((sql) => sql.includes('"IX_ORDERS_CUSTOMER"'))).toBe(true);
      expect(table.filter((sql) => sql.startsWith('CREATE UNIQUE INDEX'))).toEqual([]);
      const [proc] = await session.metadata.getDefinition({
        kind: 'procedure',
        schema: SCHEMA,
        name: 'RESTOCK',
      });
      expect(proc).toMatch(/^CREATE OR REPLACE EDITIONABLE PROCEDURE "DATANEST"\."RESTOCK"/u);
      expect(proc).toMatch(/END;$/u);
      const dump = await session.metadata.getTableDump({ schema: SCHEMA, name: 'ORDER_ITEMS' });
      expect(dump.create.join('\n')).not.toContain('REFERENCES');
      expect(dump.after.filter((sql) => sql.includes('FOREIGN KEY'))).toHaveLength(2);
      expect(dump.after.at(-1)).toMatch(/TRIGGER "DATANEST"\."ORDER_ITEMS_QUANTITY_CHECK"/u);
      await expect(
        session.metadata.getDefinition({ kind: 'view', schema: SCHEMA, name: 'NOPE' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('connecting', () => {
    it('refuses a wrong password', async () => {
      await expect(driver.openSession(config({ password: 'wrong' }))).rejects.toMatchObject({
        code: 'auth-failed',
      });
    });

    it('says when the service does not exist', async () => {
      await expect(
        driver.openSession(config({ database: 'NO_SUCH_SERVICE' })),
      ).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('fails clearly when nothing listens on the port', async () => {
      await expect(
        driver.openSession(config({ port: 7998, options: { connectTimeout: 3 } })),
      ).rejects.toMatchObject({ code: 'connection-failed' });
    });

    it('refuses TLS settings, which it does not support yet', async () => {
      await expect(driver.openSession(config({ ssl: { mode: 'require' } }))).rejects.toMatchObject({
        code: 'unsupported',
      });
    });

    it('closes twice without trouble', async () => {
      const extra = await driver.openSession(config());
      await extra.close();
      await extra.close();
      await expect(runAll(extra, 'SELECT 1 FROM dual')).rejects.toMatchObject({ code: 'internal' });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { MssqlMetadata } from '../../../../src/drivers/mssql/metadata';

/** A metadata reader over a catalog that answers by a phrase of each query. */
function metadata(answers: Record<string, unknown[][]>) {
  const asked: { sql: string; params: readonly (string | number)[] | undefined }[] = [];
  const reader = new MssqlMetadata((sql, params) => {
    asked.push({ sql, params });
    const key = Object.keys(answers).find((phrase) => sql.includes(phrase));
    return Promise.resolve(key === undefined ? [] : (answers[key] ?? []));
  });
  return { reader, asked };
}

const products = { schema: 'dbo', name: 'products' };

describe('MssqlMetadata', () => {
  it('lists databases the login may open, without blank names', async () => {
    const { reader, asked } = metadata({ 'FROM sys.databases': [['master'], ['shop'], [null]] });
    expect(await reader.listDatabases()).toEqual(['master', 'shop']);
    expect(asked[0]?.sql).toContain('HAS_DBACCESS(name) = 1');
  });

  it('lists schemas without the role schemas, dbo first', async () => {
    const { reader, asked } = metadata({ 'FROM sys.schemas': [['dbo'], ['inventory']] });
    expect(await reader.listSchemas()).toEqual(['dbo', 'inventory']);
    expect(asked[0]?.sql).toContain('schema_id < 16384');
  });

  it('lists tables and views of a schema, dbo by default', async () => {
    const { reader, asked } = metadata({
      "type IN ('U', 'V')": [
        ['customers', 'U'],
        ['order_totals', 'V'],
      ],
    });
    expect(await reader.listTables({})).toEqual([
      { name: 'customers', kind: 'table' },
      { name: 'order_totals', kind: 'view' },
    ]);
    await reader.listTables({ schema: 'inventory' });
    expect(asked.map((query) => query.params)).toEqual([['dbo'], ['inventory']]);
  });

  it('lists columns with unwrapped defaults and key flags', async () => {
    const { reader, asked } = metadata({
      'ORDER BY c.column_id': [
        ['id', 'int', false, 1, null],
        ['stock', 'int', false, 0, '((0))'],
        ['note', 'nvarchar(max)', true, 0, null],
      ],
    });
    expect(await reader.listColumns(products)).toEqual([
      { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
      { name: 'stock', dataType: 'int', nullable: false, primaryKey: false, defaultValue: '0' },
      { name: 'note', dataType: 'nvarchar(max)', nullable: true, primaryKey: false },
    ]);
    expect(asked[0]?.params).toEqual(['[dbo].[products]']);
  });

  it('groups unique keys by index', async () => {
    const { reader } = metadata({
      'i.has_filter = 0': [
        ['2', 'sku'],
        ['3', 'a'],
        ['3', 'b'],
      ],
    });
    expect(await reader.listUniqueKeys(products)).toEqual([['sku'], ['a', 'b']]);
  });

  it('groups foreign keys with their target schema and actions', async () => {
    const { reader } = metadata({
      'FROM sys.foreign_keys fk': [
        ['10', 'fk_pair', 'a', 'inventory', 'pairs', 'x', 'CASCADE', 'NO_ACTION'],
        ['10', 'fk_pair', 'b', 'inventory', 'pairs', 'y', 'CASCADE', 'NO_ACTION'],
        ['11', 'fk_odd', 'c', null, 'odd', 'id', 'SET_NULL', 'SET_DEFAULT'],
      ],
    });
    expect(await reader.listForeignKeys({ name: 'items' })).toEqual([
      {
        name: 'fk_pair',
        columns: ['a', 'b'],
        target: { schema: 'inventory', name: 'pairs' },
        targetColumns: ['x', 'y'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      },
      {
        name: 'fk_odd',
        columns: ['c'],
        target: { schema: 'dbo', name: 'odd' },
        targetColumns: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'SET DEFAULT',
      },
    ]);
  });

  it('lists functions, procedures, triggers and sequences, and no events', async () => {
    const { reader, asked } = metadata({
      "('FN', 'IF', 'TF', 'FS', 'FT')": [['order_total']],
      "('P', 'PC')": [['restock']],
      'FROM sys.triggers tr': [['tr_check', 'order_items']],
      'FROM sys.sequences': [['invoice_seq']],
    });
    const scope = { schema: 'sales' };
    expect(await reader.listObjects(scope, 'function')).toEqual([
      { name: 'order_total', kind: 'function' },
    ]);
    expect(await reader.listObjects(scope, 'procedure')).toEqual([
      { name: 'restock', kind: 'procedure' },
    ]);
    expect(await reader.listObjects(scope, 'trigger')).toEqual([
      { name: 'tr_check', kind: 'trigger', table: 'order_items' },
    ]);
    expect(await reader.listObjects(scope, 'sequence')).toEqual([
      { name: 'invoice_seq', kind: 'sequence' },
    ]);
    expect(await reader.listObjects(scope, 'event')).toEqual([]);
    expect(asked.every((query) => query.params?.[0] === 'sales')).toBe(true);
    expect(asked).toHaveLength(4);
  });

  it('groups indexes, the primary key first, with method and unwrapped filter', async () => {
    const { reader } = metadata({
      'i.type IN (5, 6)': [
        ['PK_p', true, true, 'CLUSTERED', 'id', null, false],
        ['ix_name', false, false, 'NONCLUSTERED', 'name', '([name] IS NOT NULL)', false],
        ['uq_sku', true, false, 'NONCLUSTERED', 'sku', null, true],
      ],
    });
    expect(await reader.listIndexes(products)).toEqual([
      { name: 'PK_p', columns: ['id'], unique: true, primary: true, method: 'CLUSTERED' },
      {
        name: 'ix_name',
        columns: ['name'],
        unique: false,
        primary: false,
        method: 'NONCLUSTERED',
        where: '[name] IS NOT NULL',
      },
      {
        name: 'uq_sku',
        columns: ['sku'],
        unique: true,
        primary: false,
        method: 'NONCLUSTERED',
        constraint: true,
      },
    ]);
  });

  it('describes tables, reads definitions and dumps through the catalog', async () => {
    const { reader } = metadata({
      'FROM sys.tables t WHERE': [['1', null, null]],
      "OBJECT_ID(@p1, N'U')": [[1]],
      'OBJECT_DEFINITION(o.object_id)': [[1, 'CREATE VIEW v AS SELECT 1']],
    });
    expect((await reader.describeTable(products)).columns).toEqual([]);
    expect(await reader.getDefinition({ kind: 'view', name: 'v' })).toEqual([
      'CREATE VIEW v AS SELECT 1',
    ]);
    expect((await reader.getTableDump(products)).create[0]).toMatch(
      /^CREATE TABLE \[dbo\]\.\[products\]/u,
    );
  });

  it('has no user types to dump', async () => {
    expect(await metadata({}).reader.listTypeDumps()).toEqual([]);
  });

  it('passes on errors of the catalog', async () => {
    const reader = new MssqlMetadata(() => Promise.reject(new Error('lost')));
    await expect(reader.listDatabases()).rejects.toThrow('lost');
  });
});

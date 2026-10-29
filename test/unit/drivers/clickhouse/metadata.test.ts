import { describe, expect, it } from 'vitest';
import {
  ClickhouseMetadata,
  keyColumns,
  withoutDatabase,
} from '../../../../src/drivers/clickhouse/metadata';

/** A metadata reader over a catalog that answers by a phrase of each query. */
function metadata(answers: Record<string, unknown[][]>) {
  const asked: { sql: string; params: Record<string, string> | undefined }[] = [];
  const reader = new ClickhouseMetadata((sql, params) => {
    asked.push({ sql, params });
    const key = Object.keys(answers).find((phrase) => sql.includes(phrase));
    return Promise.resolve(key === undefined ? [] : (answers[key] ?? []));
  });
  return { reader, asked };
}

const customers = { database: 'shop', name: 'customers' };

const COLUMNS = [
  ['id', 'UInt32', '', '', ''],
  ['full_name', 'Nullable(String)', '', '', 'Who'],
  ['tag', 'LowCardinality(Nullable(String))', '', '', ''],
  ['created_at', 'DateTime', 'DEFAULT', 'now()', ''],
  ['total', 'Decimal(12, 2)', 'MATERIALIZED', 'a * b', ''],
  ['alias', 'String', 'ALIAS', 'upper(full_name)', ''],
];

describe('keyColumns', () => {
  it('reads the columns of a key clause, unquoting backticks', () => {
    const columns = new Set(['id', 'customer_id', 'odd name']);
    expect(keyColumns('customer_id, id', columns)).toEqual(['customer_id', 'id']);
    expect(keyColumns('`odd name`', columns)).toEqual(['odd name']);
  });

  it('is empty when any part is an expression or the key is empty', () => {
    expect(keyColumns('toDate(ts), id', new Set(['ts', 'id']))).toEqual([]);
    expect(keyColumns('', new Set(['id']))).toEqual([]);
  });
});

describe('withoutDatabase', () => {
  it('drops the database from the name a CREATE statement makes', () => {
    expect(withoutDatabase('CREATE TABLE shop.customers\n(', 'shop')).toBe(
      'CREATE TABLE customers\n(',
    );
    expect(withoutDatabase('CREATE VIEW `shop`.v AS SELECT 1 FROM shop.t', 'shop')).toBe(
      'CREATE VIEW v AS SELECT 1 FROM shop.t',
    );
    expect(withoutDatabase('create materialized view if not exists shop.mv TO x', 'shop')).toBe(
      'create materialized view if not exists mv TO x',
    );
    expect(withoutDatabase('CREATE OR REPLACE DICTIONARY shop.d', 'shop')).toBe(
      'CREATE OR REPLACE DICTIONARY d',
    );
  });

  it('treats the database name as text, not a pattern', () => {
    expect(withoutDatabase('CREATE TABLE a.b.t', 'a.b')).toBe('CREATE TABLE t');
    expect(withoutDatabase('CREATE TABLE axb.t', 'a.b')).toBe('CREATE TABLE axb.t');
  });

  it('leaves another database, and anything but CREATE, alone', () => {
    expect(withoutDatabase('CREATE TABLE other.t', 'shop')).toBe('CREATE TABLE other.t');
    expect(withoutDatabase('SELECT * FROM shop.t', 'shop')).toBe('SELECT * FROM shop.t');
  });
});

describe('ClickhouseMetadata', () => {
  it('lists databases without blank names, and no schemas', async () => {
    const { reader } = metadata({ 'system.databases': [['default'], ['shop'], [null]] });
    expect(await reader.listDatabases()).toEqual(['default', 'shop']);
    expect(await reader.listSchemas()).toEqual([]);
  });

  it('lists tables and views of a database, materialized ones marked, inner tables left out', async () => {
    const { reader, asked } = metadata({
      'SELECT name, engine FROM system.tables': [
        ['customers', 'MergeTree'],
        ['totals', 'View'],
        ['sales', 'MaterializedView'],
        ['live', 'LiveView'],
      ],
    });
    expect(await reader.listTables({ database: 'shop' })).toEqual([
      { name: 'customers', kind: 'table' },
      { name: 'totals', kind: 'view' },
      { name: 'sales', kind: 'view', materialized: true },
      { name: 'live', kind: 'view' },
    ]);
    expect(asked[0]?.sql).toContain("NOT startsWith(name, '.inner')");
    expect(asked[0]?.sql).toContain('NOT is_temporary');
    expect(asked[0]?.params).toEqual({ db: 'shop' });
  });

  it("uses the session's database when the scope names none", async () => {
    const { reader, asked } = metadata({});
    await reader.listTables({});
    expect(asked[0]?.params).toEqual({ db: '' });
    expect(asked[0]?.sql).toContain('currentDatabase()');
  });

  it('lists columns with nullability and defaults, and never a key', async () => {
    const { reader, asked } = metadata({ 'FROM system.columns': COLUMNS });
    expect(await reader.listColumns(customers)).toEqual([
      { name: 'id', dataType: 'UInt32', nullable: false, primaryKey: false },
      { name: 'full_name', dataType: 'Nullable(String)', nullable: true, primaryKey: false },
      {
        name: 'tag',
        dataType: 'LowCardinality(Nullable(String))',
        nullable: true,
        primaryKey: false,
      },
      {
        name: 'created_at',
        dataType: 'DateTime',
        nullable: false,
        primaryKey: false,
        defaultValue: 'now()',
      },
      { name: 'total', dataType: 'Decimal(12, 2)', nullable: false, primaryKey: false },
      { name: 'alias', dataType: 'String', nullable: false, primaryKey: false },
    ]);
    expect(asked[0]?.params).toEqual({ db: 'shop', table: 'customers' });
  });

  it('has no unique keys, foreign keys, objects or types', async () => {
    const { reader, asked } = metadata({});
    expect(await reader.listUniqueKeys()).toEqual([]);
    expect(await reader.listForeignKeys()).toEqual([]);
    expect(await reader.listObjects()).toEqual([]);
    expect(await reader.listTypeDumps()).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('lists the primary or sorting key first, then the skipping indexes', async () => {
    const { reader } = metadata({
      'SELECT primary_key, sorting_key': [['customer_id', 'customer_id, id']],
      'system.data_skipping_indices': [['ix_name', 'name', 'bloom_filter']],
    });
    expect(await reader.listIndexes(customers)).toEqual([
      { name: 'PRIMARY KEY', columns: ['customer_id'], unique: false, primary: true },
      {
        name: 'ix_name',
        columns: ['name'],
        unique: false,
        primary: false,
        method: 'bloom_filter',
      },
    ]);
  });

  it('takes the sorting key when there is no primary key, and nothing when neither', async () => {
    const sorted = metadata({ 'SELECT primary_key, sorting_key': [['', 'a, b']] });
    expect((await sorted.reader.listIndexes(customers))[0]?.columns).toEqual(['a', 'b']);
    const none = metadata({ 'SELECT primary_key, sorting_key': [['', '']] });
    expect(await none.reader.listIndexes(customers)).toEqual([]);
  });

  it('describes a table: Nullable taken off the type, computed columns marked, the key', async () => {
    const { reader } = metadata({
      'SELECT comment, engine': [['Shop customers', 'MergeTree']],
      'FROM system.columns': COLUMNS,
      'SELECT primary_key, sorting_key': [['id', 'id']],
    });
    const structure = await reader.describeTable(customers);
    expect(structure.comment).toBe('Shop customers');
    expect(structure.primaryKey).toEqual(['id']);
    expect(structure.foreignKeys).toEqual([]);
    expect(structure.columns).toEqual([
      { name: 'id', dataType: 'UInt32', nullable: false, autoIncrement: false, generated: false },
      {
        name: 'full_name',
        dataType: 'String',
        nullable: true,
        autoIncrement: false,
        generated: false,
        comment: 'Who',
      },
      {
        name: 'tag',
        dataType: 'LowCardinality(Nullable(String))',
        nullable: false,
        autoIncrement: false,
        generated: false,
      },
      {
        name: 'created_at',
        dataType: 'DateTime',
        nullable: false,
        autoIncrement: false,
        generated: false,
        defaultExpression: 'now()',
      },
      {
        name: 'total',
        dataType: 'Decimal(12, 2)',
        nullable: false,
        autoIncrement: false,
        generated: true,
      },
      { name: 'alias', dataType: 'String', nullable: false, autoIncrement: false, generated: true },
    ]);
  });

  it('gives no key to the designer when the sorting key is an expression', async () => {
    const { reader } = metadata({
      'SELECT comment, engine': [['', 'MergeTree']],
      'FROM system.columns': [['ts', 'DateTime', '', '', '']],
      'SELECT primary_key, sorting_key': [['toDate(ts)', 'toDate(ts)']],
    });
    const structure = await reader.describeTable(customers);
    expect(structure.primaryKey).toEqual([]);
    expect(structure.comment).toBeUndefined();
  });

  it('describes no view and no missing table', async () => {
    const view = metadata({ 'SELECT comment, engine': [['', 'View']] });
    await expect(view.reader.describeTable(customers)).rejects.toMatchObject({ code: 'not-found' });
    const missing = metadata({});
    await expect(missing.reader.describeTable(customers)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('shows a definition without the database, trimmed of its semicolon', async () => {
    const { reader, asked } = metadata({
      'SHOW CREATE TABLE': [['CREATE TABLE shop.customers\n(\n    `id` UInt32\n);\n']],
    });
    expect(await reader.getDefinition({ kind: 'table', ...customers })).toEqual([
      'CREATE TABLE customers\n(\n    `id` UInt32\n)',
    ]);
    expect(asked[0]?.params).toEqual({ db: 'shop', table: 'customers' });
    expect(asked[0]?.sql).toBe('SHOW CREATE TABLE {db:Identifier}.{table:Identifier}');
  });

  it("asks for the session's database when the object names none, and keeps the name", async () => {
    const { reader, asked } = metadata({
      'SELECT currentDatabase()': [['default']],
      'SHOW CREATE TABLE': [['CREATE VIEW default.v AS SELECT 1']],
    });
    expect(await reader.getDefinition({ kind: 'view', name: 'v' })).toEqual([
      'CREATE VIEW default.v AS SELECT 1',
    ]);
    expect(asked[1]?.params).toEqual({ db: 'default', table: 'v' });
  });

  it('says a missing object is not found, and that there are no routines', async () => {
    const { reader } = metadata({});
    await expect(reader.getDefinition({ kind: 'table', ...customers })).rejects.toMatchObject({
      code: 'not-found',
    });
    for (const kind of ['function', 'procedure', 'trigger', 'sequence', 'event'] as const) {
      await expect(reader.getDefinition({ kind, ...customers })).rejects.toMatchObject({
        code: 'unsupported',
      });
    }
  });

  it('dumps a table as its CREATE without the database, and nothing around it', async () => {
    const { reader } = metadata({
      'SHOW CREATE TABLE': [['CREATE TABLE shop.customers (id UInt32)']],
    });
    expect(await reader.getTableDump(customers)).toEqual({
      before: [],
      create: ['CREATE TABLE customers (id UInt32)'],
      after: [],
      owns: [],
    });
  });
});

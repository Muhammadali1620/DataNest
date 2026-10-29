import { describe, expect, it, vi } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { clickhouseDialect } from '../../../../src/drivers/clickhouse/dialect';
import { oracleDialect } from '../../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import type { ObjectScope, TableRef, TableStructure } from '../../../../src/core/model/objects';
import { DbError } from '../../../../src/core/errors';
import type { SchemaAction } from '../../../../src/services/schema-actions';
import type { SqlDriverId } from '../../../../src/shared/connection';
import { newTableDesign, type TableDesign } from '../../../../src/shared/table-design';
import { TableDesignerModel } from '../../../../src/vscode/panels/table-designer-model';
import type { PerformOutcome } from '../../../../src/vscode/tree/schema-commands';

const DIALECTS = {
  mysql: mysqlDialect,
  postgres: postgresDialect,
  sqlite: sqliteDialect,
  mssql: mssqlDialect,
  clickhouse: clickhouseDialect,
  oracle: oracleDialect,
};

/** `orders (id int auto pk, note text)` with a FULLTEXT index the designer keeps. */
const ORDERS: TableStructure = {
  columns: [
    { name: 'id', dataType: 'int', nullable: false, autoIncrement: true, generated: false },
    { name: 'note', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
    { name: 'twice', dataType: 'int', nullable: true, autoIncrement: false, generated: true },
  ],
  primaryKey: ['id'],
  indexes: [
    { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
    { name: 'ft_note', columns: ['note'], unique: false, primary: false, method: 'FULLTEXT' },
  ],
  foreignKeys: [],
  comment: 'all orders',
};

function harness(
  driver: SqlDriverId,
  options: { scope?: ObjectScope; table?: string; outcome?: PerformOutcome } = {},
) {
  let structure: TableStructure | undefined = ORDERS;
  const metadata = {
    listTables: vi.fn((scope: ObjectScope) =>
      Promise.resolve(
        scope.schema === 'empty'
          ? []
          : [
              { name: 'customers', kind: 'table' as const },
              { name: 'totals', kind: 'view' as const },
            ],
      ),
    ),
    listColumns: vi.fn((table: TableRef) =>
      Promise.resolve(
        table.name === 'customers'
          ? [{ name: 'id', dataType: 'int', nullable: false, primaryKey: true }]
          : [],
      ),
    ),
    describeTable: vi.fn((table: TableRef) =>
      structure === undefined
        ? Promise.reject(new DbError('not-found', `${table.name} does not exist`))
        : Promise.resolve(structure),
    ),
  };
  const perform = vi.fn(
    (_connectionId: string, _action: SchemaAction, _title: string, _label: string) =>
      Promise.resolve(options.outcome ?? 'ran'),
  );
  const instance = new TableDesignerModel({
    connectionId: 'c1',
    scope: options.scope ?? {},
    ...(options.table === undefined ? {} : { table: options.table }),
    driver: { id: driver, dialect: DIALECTS[driver] },
    texts: {
      createTable: (name) => `create ${name}?`,
      create: 'Create',
      alterTable: (name) => `alter ${name}?`,
      apply: 'Apply',
    },
    metadata: () => Promise.resolve(metadata),
    perform,
  });
  return {
    instance,
    perform,
    metadata,
    setStructure: (next: TableStructure | undefined) => {
      structure = next;
    },
  };
}

function rename(design: TableDesign, from: string, to: string): TableDesign {
  return {
    ...design,
    columns: design.columns.map((column) =>
      column.name === from ? { ...column, name: to } : column,
    ),
  };
}

describe('TableDesignerModel: a new table', () => {
  it('labels the scope for the title', () => {
    expect(
      harness('postgres', { scope: { database: 'shop', schema: 'sales' } }).instance.scopeLabel,
    ).toBe('shop.sales');
    expect(harness('mysql', { scope: { database: 'shop' } }).instance.scopeLabel).toBe('shop');
    expect(harness('sqlite').instance.scopeLabel).toBe('');
    expect(harness('sqlite').instance.tableName).toBeUndefined();
  });

  it('starts with the driver features and the default key', async () => {
    const state = await harness('sqlite').instance.state();
    expect(state).toMatchObject({
      mode: 'create',
      driver: 'sqlite',
      scope: '',
      features: {
        columnComments: false,
        tableComment: false,
        reorder: true,
        autoIncrement: true,
        foreignKeys: true,
        uniqueIndexes: true,
      },
      design: newTableDesign('sqlite'),
      kept: { indexes: [], columns: [] },
    });
    expect((await harness('postgres').instance.state()).features.reorder).toBe(false);
  });

  it('passes on what the driver cannot do: ClickHouse has no auto numbering, keys or unique indexes (V6.3)', async () => {
    const { features } = await harness('clickhouse').instance.state();
    expect(features).toMatchObject({
      reorder: true,
      autoIncrement: false,
      foreignKeys: false,
      uniqueIndexes: false,
    });
    expect(features.types).toContain('UInt64');
  });

  it('previews the CREATE TABLE of a valid design in its scope', () => {
    const { instance } = harness('postgres', { scope: { database: 'shop', schema: 'sales' } });
    expect(instance.preview(newTableDesign('postgres', ' orders '))).toEqual({
      statements: [
        'CREATE TABLE "sales"."orders" (\n  "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  PRIMARY KEY ("id")\n)',
      ],
      notes: [],
    });
  });

  it('previews nothing while the design has problems', () => {
    expect(harness('mysql').instance.preview(newTableDesign('mysql', ''))).toEqual({
      statements: [],
      notes: [],
    });
  });

  it('creates through the performer, then holds the new table for editing', async () => {
    const { instance, perform, metadata } = harness('mysql', { scope: { database: 'shop' } });
    const design = newTableDesign('mysql', 'orders');
    expect(await instance.save(design)).toEqual({ outcome: 'ran' });
    expect(perform).toHaveBeenCalledWith(
      'c1',
      { kind: 'createTable', table: { database: 'shop', name: 'orders' }, design },
      'create orders?',
      'Create',
    );
    expect(instance.tableName).toBe('orders');
    expect((await instance.state()).mode).toBe('edit');
    expect(metadata.describeTable).toHaveBeenCalledWith({ database: 'shop', name: 'orders' });
  });

  it('stays a new table when the dialog is dismissed', async () => {
    const { instance } = harness('mysql', { outcome: 'cancelled' });
    expect(await instance.save(newTableDesign('mysql', 't'))).toEqual({ outcome: 'cancelled' });
    expect(instance.tableName).toBeUndefined();
  });

  it('refuses an invalid design without asking anything', async () => {
    const { instance, perform } = harness('sqlite');
    const design = newTableDesign('sqlite', 't');
    const broken = { ...design, columns: design.columns.map((c) => ({ ...c, type: 'text' })) };
    expect(await instance.save(broken)).toEqual({ outcome: 'invalid' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('offers the tables of its scope, not views, as targets of a key', async () => {
    const { instance, metadata } = harness('postgres', {
      scope: { database: 'shop', schema: 'sales' },
    });
    expect(await instance.tables()).toEqual({ tables: ['customers'] });
    expect(metadata.listTables).toHaveBeenLastCalledWith({ database: 'shop', schema: 'sales' });
    expect(await harness('postgres', { scope: { schema: 'empty' } }).instance.tables()).toEqual({
      tables: [],
    });
  });

  it('reads the columns of a target table in the same scope', async () => {
    const { instance, metadata } = harness('mysql', { scope: { database: 'shop' } });
    expect(await instance.columns('customers')).toEqual({ columns: ['id'] });
    expect(metadata.listColumns).toHaveBeenLastCalledWith({ database: 'shop', name: 'customers' });
    expect(await instance.columns('missing')).toEqual({ columns: [] });
  });
});

describe('TableDesignerModel: an existing table', () => {
  it('loads the table as a design and tells what it keeps as is', async () => {
    const { instance } = harness('mysql', { scope: { database: 'shop' }, table: 'orders' });
    const state = await instance.state();
    expect(state.mode).toBe('edit');
    expect(state.design).toMatchObject({ name: 'orders', comment: 'all orders' });
    expect(state.design.columns.map((column) => [column.id, column.original])).toEqual([
      ['col-1', 'id'],
      ['col-2', 'note'],
    ]);
    expect(state.kept).toEqual({
      indexes: [{ name: 'ft_note', description: 'FULLTEXT (note)' }],
      columns: ['twice'],
    });
  });

  it('previews nothing until something changes, then the ALTER', async () => {
    const { instance } = harness('mysql', { scope: { database: 'shop' }, table: 'orders' });
    const { design } = await instance.state();
    expect(instance.preview(design)).toEqual({ statements: [], notes: [] });
    expect(instance.preview(rename(design, 'note', 'remark'))).toEqual({
      statements: ['ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `note` `remark` text'],
      notes: [],
    });
  });

  it('passes on what the user should know about the ALTER', async () => {
    const { instance } = harness('postgres', { table: 'orders' });
    const { design } = await instance.state();
    const reordered = { ...design, columns: [...design.columns].reverse() };
    expect(instance.preview(reordered).notes).toEqual(['order-ignored']);
  });

  it('reports an ALTER the database cannot make as a preview error', async () => {
    const { instance, setStructure } = harness('sqlite', { table: 'orders' });
    // SQLite numbers only an INTEGER PRIMARY KEY.
    setStructure({
      ...ORDERS,
      columns: ORDERS.columns.map((c) => (c.name === 'id' ? { ...c, dataType: 'integer' } : c)),
    });
    const { design } = await instance.state();
    // SQLite has to rebuild for a type change, and cannot with a computed column.
    const changed = {
      ...design,
      columns: design.columns.map((c) => (c.name === 'note' ? { ...c, type: 'blob' } : c)),
    };
    expect(instance.preview(changed)).toMatchObject({
      statements: [],
      error: expect.stringContaining('computed columns') as unknown,
    });
  });

  it('says there is nothing to save for an unchanged design', async () => {
    const { instance, perform } = harness('mysql', { table: 'orders' });
    const { design } = await instance.state();
    expect(await instance.save(design)).toEqual({ outcome: 'unchanged' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('applies the change with the table as loaded and its background', async () => {
    const { instance, perform } = harness('mysql', {
      scope: { database: 'shop' },
      table: 'orders',
    });
    const { design } = await instance.state();
    const after = rename(design, 'note', 'remark');
    expect(await instance.save(after)).toEqual({ outcome: 'ran' });
    const [, action, title, label] = perform.mock.calls[0] ?? [];
    expect(action).toMatchObject({
      kind: 'alterTable',
      table: { database: 'shop', name: 'orders' },
      before: design,
      after,
      background: { generatedColumns: ['twice'] },
    });
    expect([title, label]).toEqual(['alter orders?', 'Apply']);
  });

  it('reloads after a save and follows a renamed table', async () => {
    const { instance, metadata } = harness('mysql', { table: 'orders' });
    const { design } = await instance.state();
    await instance.save({ ...design, name: 'purchases' });
    expect(instance.tableName).toBe('purchases');
    await instance.state();
    expect(metadata.describeTable).toHaveBeenLastCalledWith({ name: 'purchases' });
  });

  it('keeps the loaded table when the dialog is dismissed', async () => {
    const { instance, metadata } = harness('mysql', { table: 'orders', outcome: 'cancelled' });
    const { design } = await instance.state();
    await instance.save({ ...design, name: 'purchases' });
    expect(instance.tableName).toBe('orders');
    expect(metadata.describeTable).toHaveBeenCalledTimes(1);
  });

  it('fails to load a table that is gone', async () => {
    const { instance, setStructure } = harness('mysql', { table: 'orders' });
    setStructure(undefined);
    await expect(instance.state()).rejects.toMatchObject({ code: 'not-found' });
  });
});

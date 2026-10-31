import { describe, expect, it, vi } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { clickhouseDialect } from '../../../../src/drivers/clickhouse/dialect';
import { oracleDialect } from '../../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import type {
  ListedObjectKind,
  ObjectRef,
  ObjectScope,
  TableRef,
  TableStructure,
} from '../../../../src/core/model/objects';
import { DbError } from '../../../../src/core/errors';
import type { SchemaAction } from '../../../../src/services/schema-actions';
import type { SqlDriverId } from '../../../../src/shared/connection';
import type { TableTab } from '../../../../src/shared/protocols/table-designer';
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
  checks: [{ name: 'ck_note', expression: "note <> ''" }],
  comment: 'all orders',
};

function harness(
  driver: SqlDriverId,
  options: {
    scope?: ObjectScope;
    table?: string;
    outcome?: PerformOutcome;
    tab?: TableTab;
  } = {},
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
    listObjects: vi.fn((_scope: ObjectScope, _kind: ListedObjectKind) =>
      Promise.resolve([
        { name: 'trg_a', kind: 'trigger' as const, table: 'orders' },
        { name: 'trg_b', kind: 'trigger' as const, table: 'other' },
      ]),
    ),
    getDefinition: vi.fn((object: ObjectRef) =>
      Promise.resolve([`CREATE ${object.kind} ${object.name}`, 'CREATE INDEX i ON t (a)']),
    ),
    describeTable: vi.fn((table: TableRef) =>
      structure === undefined
        ? Promise.reject(new DbError('not-found', `${table.name} does not exist`))
        : Promise.resolve(structure),
    ),
  };
  const opened: string[] = [];
  const copied: string[] = [];
  const edited: ObjectRef[] = [];
  const perform = vi.fn(
    (_connectionId: string, _action: SchemaAction, _title: string, _label: string) =>
      Promise.resolve(options.outcome ?? 'ran'),
  );
  const instance = new TableDesignerModel({
    connectionId: 'c1',
    scope: options.scope ?? {},
    ...(options.table === undefined ? {} : { table: options.table }),
    ...(options.tab === undefined ? {} : { tab: options.tab }),
    driver: { id: driver, dialect: DIALECTS[driver] },
    texts: {
      createTable: (name) => `create ${name}?`,
      create: 'Create',
      alterTable: (name) => `alter ${name}?`,
      apply: 'Apply',
      dropObject: (name) => `drop ${name}?`,
      drop: 'Drop',
    },
    openSql: (sql) => {
      opened.push(sql);
      return Promise.resolve();
    },
    copyText: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
    editObject: (object) => {
      edited.push(object);
      return Promise.resolve();
    },
    metadata: () => Promise.resolve(metadata),
    perform,
  });
  return {
    instance,
    perform,
    metadata,
    opened,
    copied,
    edited,
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

describe('TableDesignerModel: the table properties page', () => {
  it('turns triggers and checks on for stored tables of databases that have them', async () => {
    expect(
      (await harness('postgres', { table: 'orders' }).instance.state()).features,
    ).toMatchObject({ triggers: true, checks: true });
    expect((await harness('sqlite', { table: 'orders' }).instance.state()).features).toMatchObject({
      triggers: true,
      checks: false,
    });
    expect(
      (await harness('clickhouse', { table: 'orders' }).instance.state()).features,
    ).toMatchObject({ triggers: false, checks: false });
    // A table being designed has nothing stored yet.
    expect((await harness('postgres').instance.state()).features).toMatchObject({
      triggers: false,
      checks: false,
    });
  });

  it('opens on the tab it was asked for', async () => {
    expect((await harness('mysql', { table: 'orders', tab: 'ddl' }).instance.state()).tab).toBe(
      'ddl',
    );
    expect((await harness('mysql', { table: 'orders' }).instance.state()).tab).toBeUndefined();
  });

  it('gives the CREATE script of the table', async () => {
    const { instance, metadata } = harness('mysql', {
      table: 'orders',
      scope: { database: 'shop' },
    });
    expect(await instance.definition()).toEqual({
      text: 'CREATE table orders;\n\nCREATE INDEX i ON t (a);',
    });
    expect(metadata.getDefinition).toHaveBeenCalledWith({
      database: 'shop',
      name: 'orders',
      kind: 'table',
    });
  });

  it('lists only the triggers of this table', async () => {
    expect(await harness('mysql', { table: 'orders' }).instance.triggers()).toEqual({
      triggers: ['trg_a'],
    });
  });

  it('views, edits, starts and drops triggers', async () => {
    const { instance, opened, edited, perform } = harness('postgres', {
      table: 'orders',
      scope: { schema: 'public' },
    });
    expect(await instance.triggerAction('view', 'trg_a')).toEqual({ outcome: 'opened' });
    expect(opened[0]).toBe('CREATE trigger trg_a;\n\nCREATE INDEX i ON t (a);');
    expect(await instance.triggerAction('edit', 'trg_a')).toEqual({ outcome: 'opened' });
    expect(edited).toEqual([{ schema: 'public', name: 'trg_a', kind: 'trigger', table: 'orders' }]);
    expect(await instance.triggerAction('new', undefined)).toEqual({ outcome: 'opened' });
    expect(opened[1]).toContain('CREATE TRIGGER');
    expect(opened[1]).toContain('"public"."orders"');
    expect(await instance.triggerAction('drop', 'trg_a')).toEqual({ outcome: 'ran' });
    expect(perform).toHaveBeenCalledWith(
      'c1',
      {
        kind: 'dropObject',
        object: { schema: 'public', name: 'trg_a', kind: 'trigger', table: 'orders' },
      },
      'drop trg_a?',
      'Drop',
    );
    expect(await instance.triggerAction('drop', undefined)).toEqual({ outcome: 'unsupported' });
  });

  it('reports a dismissed trigger drop as cancelled', async () => {
    const { instance } = harness('mysql', { table: 'orders', outcome: 'refused' });
    expect(await instance.triggerAction('drop', 'trg_a')).toEqual({ outcome: 'cancelled' });
  });

  it('reads the checks of the stored table afresh', async () => {
    const { instance, metadata } = harness('postgres', { table: 'orders' });
    expect(await instance.checks()).toEqual({
      checks: [{ name: 'ck_note', expression: "note <> ''" }],
    });
    await instance.checks();
    expect(metadata.describeTable).toHaveBeenCalledTimes(2);
  });

  it('adds and drops a check through the performer, in the table scope', async () => {
    const { instance, perform } = harness('postgres', {
      table: 'orders',
      scope: { schema: 'public' },
    });
    expect(await instance.checkAction('add', 'ck_pos', 'id > 0')).toEqual({ outcome: 'ran' });
    expect(perform).toHaveBeenLastCalledWith(
      'c1',
      {
        kind: 'runStatements',
        scope: { schema: 'public' },
        statements: ['ALTER TABLE "public"."orders" ADD CONSTRAINT "ck_pos" CHECK (id > 0)'],
      },
      'alter orders?',
      'Apply',
    );
    expect(await instance.checkAction('drop', 'ck_pos', undefined)).toEqual({ outcome: 'ran' });
    expect(perform).toHaveBeenLastCalledWith(
      'c1',
      {
        kind: 'runStatements',
        scope: { schema: 'public' },
        statements: ['ALTER TABLE "public"."orders" DROP CONSTRAINT "ck_pos"'],
      },
      'alter orders?',
      'Apply',
    );
  });

  it('answers a bad check with a message and runs nothing', async () => {
    const { instance, perform } = harness('postgres', { table: 'orders' });
    expect(await instance.checkAction('add', 'ck', '  ')).toMatchObject({
      outcome: 'unsupported',
      error: 'Enter the condition of the check',
    });
    expect(await instance.checkAction('add', '', 'id > 0')).toMatchObject({
      outcome: 'unsupported',
    });
    expect(perform).not.toHaveBeenCalled();
  });

  it('copies and opens text for the page', async () => {
    const { instance, opened, copied } = harness('mysql', { table: 'orders' });
    await instance.textAction('copy', 'a');
    await instance.textAction('open', 'b');
    expect([copied, opened]).toEqual([['a'], ['b']]);
  });
});

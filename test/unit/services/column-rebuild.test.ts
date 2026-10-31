import { describe, expect, it } from 'vitest';
import type { ForeignKey, TableRef, TableStructure } from '../../../src/core/model/objects';
import type { Dialect } from '../../../src/drivers/driver';
import { mssqlDialect } from '../../../src/drivers/mssql/dialect';
import { oracleDialect } from '../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import {
  type RebuildInput,
  REBUILD_DRIVERS,
  rebuildReorderScript,
} from '../../../src/services/column-rebuild';
import {
  canMoveColumns,
  findReferencingKeys,
  planColumnReorder,
} from '../../../src/services/column-reorder';

const TABLE: TableRef = { schema: 'public', name: 'orders' };

function column(
  name: string,
  extra: Partial<TableStructure['columns'][number]> = {},
): TableStructure['columns'][number] {
  return {
    name,
    dataType: 'integer',
    nullable: true,
    autoIncrement: false,
    generated: false,
    ...extra,
  };
}

const STRUCTURE: TableStructure = {
  columns: [
    column('id', { nullable: false, autoIncrement: true }),
    column('user_id', { comment: 'who' }),
    column('code', { dataType: 'varchar(20)', defaultExpression: "'x'" }),
    column('seq', { defaultExpression: "nextval('orders_seq_seq'::regclass)" }),
  ],
  primaryKey: ['id'],
  comment: 'the orders',
  indexes: [
    { name: 'orders_pkey', columns: ['id'], unique: true, primary: true },
    { name: 'idx_code', columns: ['code'], unique: false, primary: false },
    {
      name: 'idx_lower',
      columns: ['lower(code)'],
      unique: false,
      primary: false,
      method: 'btree',
      where: "(code <> '')",
    },
  ],
  foreignKeys: [
    {
      name: 'orders_user',
      columns: ['user_id'],
      target: { schema: 'public', name: 'users' },
      targetColumns: ['id'],
      onDelete: 'CASCADE',
    },
  ],
  checks: [{ name: 'positive', expression: 'CHECK ((seq > 0))' }],
};

const REFERENCING: RebuildInput['referencing'] = [
  {
    table: { schema: 'public', name: 'items' },
    key: {
      name: 'items_order',
      columns: ['order_id'],
      target: TABLE,
      targetColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'SET NULL',
    },
  },
];

const TRIGGERS = [
  { name: 'trg_audit', statements: ['CREATE TRIGGER trg_audit BEFORE INSERT ON orders'] },
];

function script(
  driver: 'postgres' | 'mssql' | 'oracle',
  dialect: Dialect,
  overrides: Partial<RebuildInput> = {},
): string {
  const result = rebuildReorderScript({
    driver,
    dialect,
    table: TABLE,
    structure: STRUCTURE,
    column: 'code',
    direction: 'up',
    referencing: REFERENCING,
    triggers: TRIGGERS,
    ...overrides,
  });
  if (result === undefined) {
    throw new Error('no script');
  }
  return result;
}

/** The statements, in order, without the comments. */
const statements = (text: string): string[] =>
  text.split('\n').filter((line) => !line.startsWith('--') && line.trim() !== '');

describe('rebuildReorderScript — PostgreSQL', () => {
  const text = script('postgres', postgresDialect);

  it('puts the column in its new place in the CREATE TABLE', () => {
    const create = text.slice(text.indexOf('CREATE TABLE "public"."orders"'));
    const order = ['"id"', '"code"', '"user_id"', '"seq"'].map((name) => create.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at > 0)).toBe(true);
  });

  it('runs in one transaction, in a safe order', () => {
    const lines = statements(text);
    expect(lines[0]).toBe('BEGIN;');
    expect(lines.at(-1)).toBe('COMMIT;');
    const at = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    expect(at('DROP CONSTRAINT "items_order"')).toBeLessThan(at('CREATE TABLE "public"."orders_'));
    expect(at('CREATE TABLE "public"."orders__order_backup" AS SELECT')).toBeLessThan(
      at('DROP TABLE "public"."orders";'),
    );
    expect(at('DROP TABLE "public"."orders";')).toBeLessThan(
      at('CREATE TABLE "public"."orders" ('),
    );
    expect(at('CREATE TABLE "public"."orders" (')).toBeLessThan(at('INSERT INTO'));
    expect(at('INSERT INTO')).toBeLessThan(at('ADD CONSTRAINT "items_order"'));
    expect(at('ADD CONSTRAINT "items_order"')).toBeLessThan(
      at('DROP TABLE "public"."orders__order_backup"'),
    );
  });

  it('copies the rows by column name, with identity values', () => {
    expect(text).toContain(
      'INSERT INTO "public"."orders" ("id", "code", "user_id", "seq") OVERRIDING SYSTEM VALUE SELECT "id", "code", "user_id", "seq" FROM "public"."orders__order_backup";',
    );
  });

  it('keeps the counters: identity set past the rows, serial sequences not dropped with the table', () => {
    expect(text).toContain('SELECT setval(pg_get_serial_sequence(\'"public"."orders"\', \'id\')');
    expect(text).toContain('ALTER SEQUENCE orders_seq_seq OWNED BY NONE;');
    expect(text).toContain('ALTER SEQUENCE orders_seq_seq OWNED BY "public"."orders"."seq";');
    expect(text.indexOf('OWNED BY NONE')).toBeLessThan(
      text.indexOf('DROP TABLE "public"."orders";'),
    );
  });

  it('creates again primary key, own foreign keys, indexes and comments', () => {
    expect(text).toContain('PRIMARY KEY ("id")');
    expect(text).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id")');
    expect(text).toContain('CREATE INDEX "idx_code" ON "public"."orders" ("code")');
    expect(text).toContain('COMMENT ON TABLE "public"."orders" IS \'the orders\'');
    expect(text).toContain('COMMENT ON COLUMN "public"."orders"."user_id" IS \'who\'');
  });

  it('creates again an index the designer does not edit, expression and condition kept', () => {
    expect(text).toContain(
      'CREATE INDEX "idx_lower" ON "public"."orders" USING btree (lower(code)) WHERE (code <> \'\');',
    );
  });

  it('creates again the checks and the triggers', () => {
    expect(text).toContain('ADD CONSTRAINT "positive" CHECK ((seq > 0))');
    expect(text).toContain('CREATE TRIGGER trg_audit BEFORE INSERT ON orders;');
  });

  it('adds back foreign keys of other tables with their actions', () => {
    expect(text).toContain(
      'ALTER TABLE "public"."items" ADD CONSTRAINT "items_order" FOREIGN KEY ("order_id") REFERENCES "public"."orders" ("id") ON DELETE CASCADE ON UPDATE SET NULL;',
    );
    expect(text).toContain('ALTER TABLE "public"."items" DROP CONSTRAINT "items_order";');
  });

  it('explains itself and what it leaves out', () => {
    const header = text
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .join('\n');
    expect(header).toContain('Move column code up in orders.');
    expect(header).toContain('one transaction');
    expect(header).toContain('privileges');
    expect(header).toContain('other schemas are not searched');
  });

  it('moves down as well, and is undefined at the edge', () => {
    const down = script('postgres', postgresDialect, { column: 'id', direction: 'down' });
    expect(down).toContain('Move column id down');
    expect(
      rebuildReorderScript({
        driver: 'postgres',
        dialect: postgresDialect,
        table: TABLE,
        structure: STRUCTURE,
        column: 'id',
        direction: 'up',
        referencing: [],
        triggers: [],
      }),
    ).toBeUndefined();
    expect(
      rebuildReorderScript({
        driver: 'postgres',
        dialect: postgresDialect,
        table: TABLE,
        structure: STRUCTURE,
        column: 'seq',
        direction: 'down',
        referencing: [],
        triggers: [],
      }),
    ).toBeUndefined();
  });

  it('has no step for what is not there', () => {
    const bare = script('postgres', postgresDialect, {
      structure: {
        columns: [column('a'), column('b')],
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
      },
      column: 'b',
      referencing: [],
      triggers: [],
    });
    expect(bare).not.toContain('setval');
    expect(bare).not.toContain('OWNED BY');
    expect(bare).not.toContain('OVERRIDING');
    expect(bare).not.toContain('Trigger ');
  });

  it('says when only part of a big schema was searched', () => {
    expect(script('postgres', postgresDialect, { checkedTables: 400 })).toContain(
      'Only 400 tables of the schema were searched',
    );
  });

  it('refuses a table with computed columns', () => {
    expect(() =>
      script('postgres', postgresDialect, {
        structure: {
          ...STRUCTURE,
          columns: [...STRUCTURE.columns, column('total', { generated: true })],
        },
      }),
    ).toThrow(/computed columns \(total\)/u);
  });

  it('refuses a column that is not there', () => {
    expect(() => script('postgres', postgresDialect, { column: 'nope' })).toThrow(
      /cannot be moved/u,
    );
  });
});

describe('rebuildReorderScript — SQL Server', () => {
  const text = script('mssql', mssqlDialect, { table: { schema: 'dbo', name: 'orders' } });

  it('runs in a transaction and copies through SELECT INTO', () => {
    const lines = statements(text);
    expect(lines[0]).toBe('BEGIN TRANSACTION;');
    expect(lines.at(-1)).toBe('COMMIT TRANSACTION;');
    expect(text).toContain('SELECT * INTO [dbo].[orders__order_backup] FROM [dbo].[orders];');
  });

  it('inserts identity values explicitly', () => {
    const on = text.indexOf('SET IDENTITY_INSERT [dbo].[orders] ON;');
    const insert = text.indexOf('INSERT INTO [dbo].[orders]');
    const off = text.indexOf('SET IDENTITY_INSERT [dbo].[orders] OFF;');
    expect(on).toBeGreaterThan(0);
    expect(on).toBeLessThan(insert);
    expect(insert).toBeLessThan(off);
  });

  it('does not touch sequences (it has no serial defaults)', () => {
    expect(text).not.toContain('OWNED BY');
    expect(text).not.toContain('OVERRIDING');
  });

  it('only describes an index it cannot write', () => {
    expect(text).toContain('-- Create again by hand: idx_lower btree (lower(code)) WHERE');
  });
});

describe('rebuildReorderScript — Oracle', () => {
  const text = script('oracle', oracleDialect, { table: { schema: 'APP', name: 'ORDERS' } });

  it('says there is no rollback and keeps the rows in the backup', () => {
    expect(text).toContain('no rollback');
    expect(text).toContain(
      'CREATE TABLE "APP"."ORDERS__order_backup" AS SELECT * FROM "APP"."ORDERS";',
    );
    expect(statements(text)[0]).toContain('ALTER TABLE'); // no BEGIN
    expect(statements(text).at(-1)).toBe('COMMIT;');
  });

  it('starts the identity counter past the rows', () => {
    expect(text).toContain(
      'ALTER TABLE "APP"."ORDERS" MODIFY ("id" GENERATED BY DEFAULT AS IDENTITY (START WITH LIMIT VALUE));',
    );
  });

  it('writes foreign keys of other tables without ON UPDATE, which Oracle has none of', () => {
    expect(text).toContain('ON DELETE CASCADE;');
    expect(text).not.toContain('ON UPDATE');
  });

  it('keeps only CASCADE and SET NULL of the delete rules', () => {
    const first = REFERENCING[0];
    if (first === undefined) throw new Error('fixture has no referencing keys');
    const restrict: ForeignKey = {
      ...first.key,
      name: 'k2',
      onDelete: 'RESTRICT',
    };
    const out = script('oracle', oracleDialect, {
      referencing: [{ table: { name: 'T2' }, key: restrict }],
    });
    expect(out.split('\n').find((line) => line.includes('"k2" FOREIGN KEY'))).not.toContain(
      'ON DELETE',
    );
  });
});

describe('rebuildReorderScript — others', () => {
  it('refuses a database that moves columns itself or has no way', () => {
    expect(() =>
      rebuildReorderScript({
        driver: 'mysql',
        dialect: mysqlDialect,
        table: TABLE,
        structure: STRUCTURE,
        column: 'code',
        direction: 'up',
        referencing: [],
        triggers: [],
      }),
    ).toThrow(/cannot rebuild/u);
  });

  it('is offered for PostgreSQL, SQL Server and Oracle, and by ALTER for the rest that can', () => {
    expect([...REBUILD_DRIVERS].sort()).toEqual(['mssql', 'oracle', 'postgres']);
    for (const id of ['postgres', 'mssql', 'oracle', 'mysql', 'sqlite', 'clickhouse'] as const) {
      expect(canMoveColumns(id), id).toBe(true);
    }
    for (const id of ['redis', 'mongodb', 'elasticsearch'] as const) {
      expect(canMoveColumns(id), id).toBe(false);
    }
  });
});

describe('findReferencingKeys and planColumnReorder', () => {
  const key = (from: string, to: string, targetSchema = 'public'): ForeignKey => ({
    name: `${from}_${to}`,
    columns: ['x'],
    target: { schema: targetSchema, name: to },
    targetColumns: ['id'],
  });
  const structures: Record<string, TableStructure> = {
    orders: STRUCTURE,
    items: { ...STRUCTURE, foreignKeys: [key('items', 'orders')] },
    notes: { ...STRUCTURE, foreignKeys: [key('notes', 'orders', 'other')] },
    users: { ...STRUCTURE, foreignKeys: [key('users', 'users')] },
  };
  const reader = {
    listTables: () =>
      Promise.resolve(
        ['orders', 'items', 'notes', 'users'].map((name) => ({ name, kind: 'table' as const })),
      ),
    describeTable: (table: TableRef) => Promise.resolve(structures[table.name] ?? STRUCTURE),
    listObjects: () =>
      Promise.resolve([
        { name: 'trg_audit', kind: 'trigger' as const, table: 'orders' },
        { name: 'trg_other', kind: 'trigger' as const, table: 'items' },
      ]),
    getDefinition: (object: { name: string }) =>
      Promise.resolve([`CREATE TRIGGER ${object.name} ON orders`]),
  };

  it('finds the keys that point at the table from its own schema only', async () => {
    const found = await findReferencingKeys(reader, TABLE);
    expect(found.keys.map((entry) => entry.key.name)).toEqual(['items_orders']);
    expect(found.keys[0]?.table).toEqual({ schema: 'public', name: 'items' });
    expect(found.checked).toBeUndefined();
  });

  it('plans a script with those keys and only the triggers of the table', async () => {
    const plan = await planColumnReorder(
      reader,
      { id: 'postgres', dialect: postgresDialect },
      TABLE,
      'code',
      'up',
    );
    expect(plan?.kind).toBe('script');
    const sql = plan?.kind === 'script' ? plan.sql : '';
    expect(sql).toContain('"items_orders"');
    expect(sql).toContain('CREATE TRIGGER trg_audit ON orders;');
    expect(sql).not.toContain('trg_other');
  });

  it('plans an action where the database moves columns itself', async () => {
    const plan = await planColumnReorder(
      reader,
      { id: 'mysql', dialect: mysqlDialect },
      { database: 'app', name: 'orders' },
      'code',
      'up',
    );
    expect(plan?.kind).toBe('action');
  });

  it('plans nothing at the edge and refuses a database without a way', async () => {
    expect(
      await planColumnReorder(
        reader,
        { id: 'postgres', dialect: postgresDialect },
        TABLE,
        'id',
        'up',
      ),
    ).toBeUndefined();
    await expect(
      planColumnReorder(reader, { id: 'redis', dialect: postgresDialect }, TABLE, 'code', 'up'),
    ).rejects.toThrow(/cannot move a column/u);
  });
});

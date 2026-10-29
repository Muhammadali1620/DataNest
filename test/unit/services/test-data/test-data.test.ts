import { describe, expect, it } from 'vitest';
import type { TableStructure } from '../../../../src/core/model/objects';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import type { SourceRecord } from '../../../../src/services/import/import-source';
import {
  asRecords,
  type ColumnChoice,
  columnSettings,
  filledColumns,
  generateRows,
  insertScript,
  loadContext,
  planColumns,
  suggestChoices,
} from '../../../../src/services/test-data/test-data';
import { FakeSession } from '../../../helpers/fake-driver';

const STRUCTURE: TableStructure = {
  columns: [
    { name: 'id', dataType: 'integer', nullable: false, autoIncrement: true, generated: false },
    {
      name: 'email',
      dataType: 'varchar(100)',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
    {
      name: 'customer_id',
      dataType: 'integer',
      nullable: true,
      autoIncrement: false,
      generated: false,
    },
    { name: 'code', dataType: 'integer', nullable: false, autoIncrement: false, generated: false },
    { name: 'note', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
    { name: 'total', dataType: 'integer', nullable: true, autoIncrement: false, generated: true },
  ],
  primaryKey: ['id'],
  indexes: [
    { name: 'pk', columns: ['id'], unique: true, primary: true },
    { name: 'ux_email', columns: ['email'], unique: true, primary: false },
    { name: 'ux_code', columns: ['code'], unique: true, primary: false },
    { name: 'ux_pair', columns: ['email', 'note'], unique: true, primary: false },
  ],
  foreignKeys: [
    {
      name: 'fk',
      columns: ['customer_id'],
      target: { schema: 'public', name: 'customers' },
      targetColumns: ['id'],
    },
  ],
};

const COLUMNS = planColumns(STRUCTURE);

describe('planColumns', () => {
  it('marks one-column keys unique and one-column foreign keys as references', () => {
    expect(COLUMNS.map((column) => [column.name, column.unique])).toEqual([
      ['id', true],
      ['email', true],
      ['customer_id', false],
      ['code', true],
      ['note', false],
      ['total', false],
    ]);
    expect(COLUMNS[2]?.reference).toEqual({ table: 'public.customers', column: 'id' });
  });
});

describe('suggestChoices', () => {
  it('suggests a generator per column and no NULLs', () => {
    expect(suggestChoices(COLUMNS)).toEqual([
      { generator: 'default', nullPercent: 0 },
      { generator: 'email', nullPercent: 0 },
      { generator: 'reference', nullPercent: 0 },
      { generator: 'sequence', nullPercent: 0 },
      { generator: 'sentence', nullPercent: 0 },
      { generator: 'default', nullPercent: 0 },
    ]);
  });
});

describe('loadContext', () => {
  it('reads existing keys for references and the highest value for sequences', async () => {
    const session = new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });
    session.rowsFor = (sql) =>
      sql.startsWith('SELECT DISTINCT') ? [[7], [9]] : sql.startsWith('SELECT MAX') ? [[41]] : [];
    const context = await loadContext(
      session,
      postgresDialect,
      { schema: 'public', name: 'orders' },
      STRUCTURE,
      suggestChoices(COLUMNS),
    );
    expect(context.references.get('customer_id')).toEqual(['7', '9']);
    expect(context.starts.get('code')).toBe(42);
    expect(session.executed).toEqual([
      'SELECT DISTINCT "id" FROM "public"."customers" WHERE "id" IS NOT NULL LIMIT 1000',
      'SELECT MAX("code") FROM "public"."orders"',
    ]);
  });

  it('starts a sequence at 1 in an empty table', async () => {
    const session = new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });
    session.rows = [[null]];
    const choices: ColumnChoice[] = COLUMNS.map((column) => ({
      generator: column.name === 'code' ? 'sequence' : 'default',
      nullPercent: 0,
    }));
    const context = await loadContext(session, postgresDialect, { name: 'o' }, STRUCTURE, choices);
    expect(context.starts.get('code')).toBe(1);
  });
});

describe('generating rows', () => {
  const context = {
    references: new Map([['customer_id', ['7', '9']]]),
    starts: new Map([['code', 42]]),
  };

  it('gives the same rows for the same seed, following each choice', () => {
    const choices = suggestChoices(COLUMNS);
    const settings = columnSettings(COLUMNS, choices, context);
    const rows = [...generateRows(settings, choices, COLUMNS, 3, 5)];
    expect([...generateRows(settings, choices, COLUMNS, 3, 5)]).toEqual(rows);
    expect(rows.map((row) => row[0])).toEqual([null, null, null]);
    expect(rows.map((row) => row[3])).toEqual(['42', '43', '44']);
    expect(rows.every((row) => ['7', '9'].includes(row[2] ?? ''))).toBe(true);
    expect(rows.every((row) => (row[1] ?? '').length <= 100)).toBe(true);
  });

  it('puts in about the chosen share of NULLs, only where NULL is allowed', () => {
    const choices = suggestChoices(COLUMNS).map((choice, index) =>
      index === 4 || index === 1 ? { ...choice, nullPercent: 50 } : choice,
    );
    const settings = columnSettings(COLUMNS, choices, context);
    const rows = [...generateRows(settings, choices, COLUMNS, 1000, 1)];
    const nulls = rows.filter((row) => row[4] === null).length;
    expect(nulls).toBeGreaterThan(400);
    expect(nulls).toBeLessThan(600);
    expect(rows.some((row) => row[1] === null)).toBe(false);
  });

  it('fills only the columns not left to the database', () => {
    expect(filledColumns(COLUMNS, suggestChoices(COLUMNS)).map((column) => column.name)).toEqual([
      'email',
      'customer_id',
      'code',
      'note',
    ]);
  });

  it('turns rows into numbered import records', async () => {
    const records: SourceRecord[] = [];
    for await (const record of asRecords([['a'], ['b']])) {
      records.push(record);
    }
    expect(records).toEqual([
      { line: 1, values: ['a'] },
      { line: 2, values: ['b'] },
    ]);
  });

  it('writes the rows as INSERT statements', () => {
    const choices = suggestChoices(COLUMNS);
    const columns = filledColumns(COLUMNS, choices);
    const script = insertScript(
      postgresDialect,
      'postgres',
      { schema: 'public', name: 'orders' },
      columns,
      [
        [null, 'a@example.com', '7', '42', "it's", null],
        [null, 'b@example.com', null, 'x', null, null],
      ],
    );
    expect(script).toBe(
      'INSERT INTO "public"."orders" ("email", "customer_id", "code", "note") VALUES\n' +
        "('a@example.com', 7, 42, 'it''s'),\n('b@example.com', NULL, NULL, NULL);\n",
    );
  });
});

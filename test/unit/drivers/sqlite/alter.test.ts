import { describe, expect, it } from 'vitest';
import { renameColumnsIn } from '../../../../src/drivers/sqlite/alter';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import {
  NO_BACKGROUND,
  type TableBackground,
  type TableDesign,
} from '../../../../src/shared/table-design';
import { added, column, ordersDesign, withColumn } from '../../../helpers/designs';

const table = { name: 'orders' };
const before = ordersDesign({
  columns: [
    column('id', { type: 'integer', primaryKey: true, nullable: false }),
    column('customer_id', { type: 'integer' }),
    column('note', { type: 'text' }),
  ],
});

function alter(after: TableDesign, background: TableBackground = NO_BACKGROUND) {
  return sqliteDialect.ddl.alterTable(table, before, after, background);
}

describe('sqlite alterTable in place', () => {
  it('does nothing for an unchanged table', () => {
    expect(alter(structuredClone(before)).statements).toEqual([]);
  });

  it('renames columns and the table, adds nullable columns and plain indexes', () => {
    const after: TableDesign = {
      ...withColumn(before, 'note', { name: 'remark' }),
      name: 'purchases',
      columns: [
        ...withColumn(before, 'note', { name: 'remark' }).columns,
        added('total', { type: 'real', defaultValue: '0', nullable: false }),
      ],
      indexes: [{ id: 'i2', name: 'ix_total', columns: ['new-total'], unique: false }],
    };
    expect(alter(after)).toEqual({
      statements: [
        'BEGIN',
        'DROP INDEX "ix_note"',
        'ALTER TABLE "orders" RENAME COLUMN "note" TO "remark"',
        'ALTER TABLE "orders" ADD COLUMN "total" real NOT NULL DEFAULT 0',
        'CREATE INDEX "ix_total" ON "orders" ("total")',
        'ALTER TABLE "orders" RENAME TO "purchases"',
        'COMMIT',
      ],
      notes: [],
      recovery: ['ROLLBACK'],
    });
  });

  it('names indexes of an attached database with the prefix', () => {
    const after = { ...before, indexes: [] };
    const plan = sqliteDialect.ddl.alterTable(
      { database: 'aux', name: 'orders' },
      before,
      after,
      NO_BACKGROUND,
    );
    expect(plan.statements).toContain('DROP INDEX "aux"."ix_note"');
  });
});

describe('sqlite alterTable by rebuild', () => {
  const rebuilds = (after: TableDesign) => alter(after).notes.includes('rebuild');

  it('rebuilds for what ALTER TABLE cannot do in place', () => {
    expect(rebuilds(withColumn(before, 'note', { type: 'blob' }))).toBe(true);
    expect(rebuilds(withColumn(before, 'note', { nullable: false }))).toBe(true);
    expect(rebuilds(withColumn(before, 'note', { defaultValue: "''" }))).toBe(true);
    expect(rebuilds({ ...before, columns: before.columns.slice(0, 2) })).toBe(true);
    expect(rebuilds({ ...before, columns: [...before.columns].reverse() })).toBe(true);
    expect(rebuilds({ ...before, foreignKeys: [] })).toBe(true);
    expect(rebuilds(withColumn(before, 'customer_id', { primaryKey: true }))).toBe(true);
  });

  it('rebuilds to add a column ADD COLUMN cannot take', () => {
    const add = (column: ReturnType<typeof added>) => ({
      ...before,
      columns: [...before.columns, column],
    });
    expect(rebuilds(add(added('a', { nullable: false })))).toBe(true);
    expect(rebuilds(add(added('b', { defaultValue: 'CURRENT_TIMESTAMP' })))).toBe(true);
    expect(rebuilds(add(added('c', { primaryKey: true })))).toBe(true);
    expect(rebuilds(add(added('d', { nullable: false, defaultValue: 'NULL' })))).toBe(true);
    expect(rebuilds(add(added('e', { defaultValue: "'it''s'" })))).toBe(false);
    expect(rebuilds(add(added('f', { defaultValue: '-1.5' })))).toBe(false);
  });

  it('rebuilds to drop an automatic index', () => {
    const from = {
      ...before,
      indexes: [
        {
          id: 'i9',
          original: 'sqlite_autoindex_orders_1',
          name: 'sqlite_autoindex_orders_1',
          columns: ['note'],
          unique: true,
        },
      ],
    };
    const plan = sqliteDialect.ddl.alterTable(table, from, { ...from, indexes: [] }, NO_BACKGROUND);
    expect(plan.notes).toEqual(['rebuild']);
  });

  it('copies the rows into a new table, swaps it in, and recreates what was lost', () => {
    const after: TableDesign = {
      ...withColumn(before, 'note', { name: 'remark', type: 'varchar', length: '100' }),
      name: 'purchases',
      columns: [
        ...withColumn(before, 'note', {
          name: 'remark',
          type: 'varchar',
          length: '100',
        }).columns.filter((c) => c.name !== 'customer_id'),
        added('total', { type: 'real' }),
      ],
      foreignKeys: [],
    };
    const plan = alter(after, {
      ...NO_BACKGROUND,
      rebuildSql: ['CREATE TRIGGER t AFTER INSERT ON orders BEGIN SELECT note; END'],
    });
    expect(plan.statements).toEqual([
      'PRAGMA foreign_keys = OFF',
      'BEGIN',
      // Renamed in place first, so SQLite carries the name into views and triggers.
      'ALTER TABLE "orders" RENAME COLUMN "note" TO "remark"',
      'PRAGMA legacy_alter_table = ON',
      'CREATE TABLE "purchases__datanest_rebuild" (\n  "id" integer NOT NULL,\n  "remark" varchar(100),\n  "total" real,\n  PRIMARY KEY ("id")\n)',
      'INSERT INTO "purchases__datanest_rebuild" ("id", "remark") SELECT "id", "remark" FROM "orders"',
      'DROP TABLE "orders"',
      'ALTER TABLE "purchases__datanest_rebuild" RENAME TO "orders"',
      'PRAGMA legacy_alter_table = OFF',
      'CREATE INDEX "ix_note" ON "orders" ("remark")',
      'CREATE TRIGGER t AFTER INSERT ON orders BEGIN SELECT "remark"; END',
      'ALTER TABLE "orders" RENAME TO "purchases"',
      'COMMIT',
    ]);
    expect(plan.recovery).toEqual(['ROLLBACK', 'PRAGMA legacy_alter_table = OFF']);
  });

  it('refuses to rebuild a table with computed columns', () => {
    expect(() =>
      alter(withColumn(before, 'note', { type: 'blob' }), {
        ...NO_BACKGROUND,
        generatedColumns: ['twice'],
      }),
    ).toThrow(expect.objectContaining({ code: 'unsupported' }));
    // A change that needs no rebuild still works.
    expect(
      alter(withColumn(before, 'note', { name: 'x' }), {
        ...NO_BACKGROUND,
        generatedColumns: ['twice'],
      }).notes,
    ).toEqual([]);
  });
});

describe('renameColumnsIn', () => {
  const renames = new Map([
    ['note', 'remark'],
    ['owner id', 'owner'],
  ]);

  it('renames bare and quoted column names, whatever their case', () => {
    expect(renameColumnsIn('CREATE INDEX i ON t (Note, "owner id")', renames)).toBe(
      'CREATE INDEX i ON t ("remark", "owner")',
    );
  });

  it('leaves strings, comments and other words alone', () => {
    const sql =
      "CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 'note' -- note\n; SELECT notes; END";
    expect(renameColumnsIn(sql, renames)).toBe(sql);
  });

  it('returns the text unchanged when nothing is renamed', () => {
    expect(renameColumnsIn('CREATE INDEX i ON t (note)', new Map())).toBe(
      'CREATE INDEX i ON t (note)',
    );
  });
});

describe('sqlite rebuild keeps what the design does not describe', () => {
  const checks = [
    { name: 'unnamed_check_1', expression: '(customer_id > 0)' },
    { name: 'note_short', expression: "(length(note) < 100 AND note <> 'a)b')" },
  ];
  const background: TableBackground = {
    ...NO_BACKGROUND,
    checks,
    tableOptions: 'STRICT',
  };
  const create = (plan: { statements: readonly string[] }) =>
    plan.statements.find((s) => s.includes('CREATE TABLE')) ?? '';

  it('writes the checks and the table options into the new table', () => {
    const plan = alter(withColumn(before, 'note', { type: 'blob' }), background);
    expect(create(plan)).toBe(
      'CREATE TABLE "orders__datanest_rebuild" (\n  "id" integer NOT NULL,\n  "customer_id" integer,\n  "note" blob,\n  PRIMARY KEY ("id"),\n' +
        '  CONSTRAINT "fk_customer" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id"),\n' +
        '  CHECK (customer_id > 0),\n  CONSTRAINT "note_short" CHECK (length(note) < 100 AND note <> \'a)b\')\n) STRICT',
    );
  });

  it('follows a renamed column inside the condition, but not inside strings', () => {
    const rebuilt = alter(withColumn(before, 'note', { name: 'remark', type: 'blob' }), {
      ...NO_BACKGROUND,
      checks: [{ name: 'c', expression: '(note <> \'note\' AND length("note") > 0)' }],
    });
    expect(create(rebuilt)).toContain(
      `CONSTRAINT "c" CHECK ("remark" <> 'note' AND length("remark") > 0)`,
    );
  });

  it('leaves out a check that reads a dropped column and says so', () => {
    const plan = alter({ ...before, columns: before.columns.slice(0, 2) }, background);
    const text = create(plan);
    expect(
      text.startsWith('-- CHECK note_short is dropped with the column note\nCREATE TABLE'),
    ).toBe(true);
    expect(text).toContain('CHECK (customer_id > 0)');
    expect(text).not.toContain('note_short" CHECK');
  });

  it('adds no comment and no options when there is nothing to carry', () => {
    const text = create(alter(withColumn(before, 'note', { type: 'blob' })));
    expect(text.startsWith('CREATE TABLE')).toBe(true);
    expect(text.endsWith('\n)')).toBe(true);
  });
});

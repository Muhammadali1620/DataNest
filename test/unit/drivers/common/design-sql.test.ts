import { describe, expect, it } from 'vitest';
import {
  columnList,
  columnSql,
  createIndexSql,
  createTableSql,
  foreignKeySql,
  referentialActions,
  primaryKeySql,
  type ColumnSqlParts,
} from '../../../../src/drivers/common/design-sql';
import type {
  ColumnDesign,
  ForeignKeyDesign,
  TableDesign,
} from '../../../../src/shared/table-design';

const parts: ColumnSqlParts = {
  quote: (name) => `"${name}"`,
  autoIncrement: () => 'AUTO',
  trailer: (column) => (column.comment === '' ? '' : `COMMENT '${column.comment}'`),
};

function column(overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return {
    id: 'c',
    name: 'price',
    type: 'decimal unsigned',
    length: '10,2',
    nullable: true,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
    ...overrides,
  };
}

describe('columnSql', () => {
  it('writes a plain nullable column', () => {
    expect(columnSql(column(), parts)).toBe('"price" decimal(10,2) unsigned');
  });

  it('adds auto numbering, NOT NULL, the default and the trailer in this order', () => {
    expect(
      columnSql(
        column({ autoIncrement: true, nullable: false, defaultValue: ' 0 ', comment: 'c' }),
        parts,
      ),
    ).toBe(`"price" decimal(10,2) unsigned AUTO NOT NULL DEFAULT 0 COMMENT 'c'`);
  });

  it('makes a key column NOT NULL even when it was left nullable', () => {
    expect(columnSql(column({ primaryKey: true }), parts)).toBe(
      '"price" decimal(10,2) unsigned NOT NULL',
    );
  });

  it('trims the name', () => {
    expect(columnSql(column({ name: '  id ', type: 'int', length: '' }), parts)).toBe('"id" int');
  });
});

describe('primaryKeySql', () => {
  it('lists the key columns in design order', () => {
    const design = {
      name: 't',
      indexes: [],
      foreignKeys: [],
      comment: '',
      columns: [
        column({ name: 'b', primaryKey: true }),
        column({ name: 'x' }),
        column({ name: 'a', primaryKey: true }),
      ],
    };
    expect(primaryKeySql(design, parts.quote)).toEqual(['PRIMARY KEY ("b", "a")']);
  });

  it('is empty for a table without a key', () => {
    expect(
      primaryKeySql(
        { name: 't', comment: '', columns: [column()], indexes: [], foreignKeys: [] },
        parts.quote,
      ),
    ).toEqual([]);
  });
});

describe('createTableSql', () => {
  it('puts one item per line and appends table options', () => {
    expect(createTableSql('"t"', ['"a" int', '"b" text'], ' COMMENT = 1')).toBe(
      'CREATE TABLE "t" (\n  "a" int,\n  "b" text\n) COMMENT = 1',
    );
  });
});

describe('indexes and keys', () => {
  const design: TableDesign = {
    name: 't',
    comment: '',
    columns: [column({ id: 'a', name: 'a' }), column({ id: 'b', name: ' b ' })],
    indexes: [],
    foreignKeys: [],
  };
  const key: ForeignKeyDesign = {
    id: 'k',
    name: ' fk ',
    columns: ['b', 'a'],
    targetTable: 'p',
    targetColumns: ['y', ' x '],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
  };

  it('lists columns by their current names', () => {
    expect(columnList(design, ['b', 'a'], parts.quote)).toBe('("b", "a")');
  });

  it('leaves out the default actions', () => {
    expect(referentialActions(key)).toBe('');
    expect(referentialActions({ ...key, onDelete: 'CASCADE' })).toBe('ON DELETE CASCADE');
    expect(referentialActions({ ...key, onDelete: 'SET NULL', onUpdate: 'RESTRICT' })).toBe(
      'ON DELETE SET NULL ON UPDATE RESTRICT',
    );
  });

  it('writes a named foreign key', () => {
    expect(foreignKeySql(design, key, parts.quote, '"s"."p"')).toBe(
      'CONSTRAINT "fk" FOREIGN KEY ("b", "a") REFERENCES "s"."p" ("y", "x")',
    );
    expect(foreignKeySql(design, { ...key, onUpdate: 'CASCADE' }, parts.quote, '"p"')).toMatch(
      / ON UPDATE CASCADE$/,
    );
  });

  it('writes CREATE INDEX with an optional qualified name', () => {
    const index = { id: 'i', name: ' ix ', columns: ['a'], unique: true };
    expect(createIndexSql(design, index, parts.quote, '"t"')).toBe(
      'CREATE UNIQUE INDEX "ix" ON "t" ("a")',
    );
    expect(
      createIndexSql(design, { ...index, unique: false }, parts.quote, '"t"', '"aux"."ix"'),
    ).toBe('CREATE INDEX "aux"."ix" ON "t" ("a")');
  });
});

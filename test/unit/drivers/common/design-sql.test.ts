import { describe, expect, it } from 'vitest';
import {
  columnSql,
  createTableSql,
  primaryKeySql,
  type ColumnSqlParts,
} from '../../../../src/drivers/common/design-sql';
import type { ColumnDesign } from '../../../../src/shared/table-design';

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
    expect(primaryKeySql({ name: 't', comment: '', columns: [column()] }, parts.quote)).toEqual([]);
  });
});

describe('createTableSql', () => {
  it('puts one item per line and appends table options', () => {
    expect(createTableSql('"t"', ['"a" int', '"b" text'], ' COMMENT = 1')).toBe(
      'CREATE TABLE "t" (\n  "a" int,\n  "b" text\n) COMMENT = 1',
    );
  });
});

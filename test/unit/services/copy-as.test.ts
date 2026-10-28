import { describe, expect, it } from 'vitest';
import type { EditableResult } from '../../../src/core/model/editability';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import { binaryValue } from '../../../src/drivers/common/values';
import { copyAs, type CopyInput, PLACEHOLDER_TABLE } from '../../../src/services/copy-as';
import type { CellValue } from '../../../src/shared/cell-value';

const COLUMNS = [{ name: 'id' }, { name: 'name' }, { name: 'price' }];
const ROWS: CellValue[][] = [
  [1, 'alice', { kind: 'decimal', text: '9.90' }],
  [2, "o'brien", null],
  [3, 'a|b\nc', { kind: 'decimal', text: '10' }],
];

const EDIT: EditableResult = {
  editable: true,
  table: { name: 'items' },
  columnMap: ['id', 'name', 'price'],
  columns: [null, null, null],
  keyColumns: ['id'],
  keyIndexes: [0],
};

function input(overrides: Partial<CopyInput>): CopyInput {
  return {
    format: 'csv',
    columns: COLUMNS,
    rows: ROWS,
    left: 0,
    right: 2,
    dialect: sqliteDialect,
    edit: EDIT,
    ...overrides,
  };
}

function text(overrides: Partial<CopyInput>): string {
  const outcome = copyAs(input(overrides));
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.error}`);
  }
  return outcome.text;
}

describe('copyAs text formats', () => {
  it('writes TSV and CSV with a header for the selected columns only', () => {
    expect(text({ format: 'tsv', left: 1, right: 2, rows: [ROWS[0] ?? []] })).toBe(
      'name\tprice\r\nalice\t9.90',
    );
    expect(text({ format: 'csv', left: 0, right: 1, rows: [ROWS[1] ?? []] })).toBe(
      "id,name\r\n2,o'brien\r\n",
    );
  });

  it('quotes CSV fields that need it', () => {
    expect(text({ format: 'csv', left: 1, right: 1, rows: [ROWS[2] ?? []] })).toBe(
      'name\r\n"a|b\nc"\r\n',
    );
  });

  it('writes JSON objects with exact numbers as text and NULL as null', () => {
    const parsed: unknown = JSON.parse(text({ format: 'json', rows: ROWS.slice(0, 2) }));
    expect(parsed).toEqual([
      { id: 1, name: 'alice', price: '9.90' },
      { id: 2, name: "o'brien", price: null },
    ]);
  });

  it('numbers duplicate column names so no JSON key is lost', () => {
    const parsed = JSON.parse(
      text({
        format: 'json',
        columns: [{ name: 'a' }, { name: 'a' }],
        rows: [[1, 2]],
        left: 0,
        right: 1,
      }),
    ) as Record<string, unknown>[];
    expect(parsed[0]).toEqual({ a: 1, a_2: 2 });
  });

  it('writes a Markdown table, right-aligning numbers and escaping pipes and newlines', () => {
    expect(text({ format: 'markdown' })).toBe(
      [
        '| id | name | price |',
        '| ---: | --- | ---: |',
        '| 1 | alice | 9.90 |',
        "| 2 | o'brien | NULL |",
        '| 3 | a\\|b<br>c | 10 |',
      ].join('\n'),
    );
  });

  it('does not right-align a column that is all NULL', () => {
    expect(text({ format: 'markdown', columns: [{ name: 'x' }], rows: [[null]], right: 0 })).toBe(
      '| x |\n| --- |\n| NULL |',
    );
  });

  it('copes with a selection wider than the rows', () => {
    expect(text({ format: 'tsv', rows: [[1]], left: 0, right: 2 })).toContain('id\tname\tprice');
  });
});

describe('copyAs INSERT', () => {
  it('writes one statement per row through the dialect', () => {
    expect(text({ format: 'insert', rows: ROWS.slice(0, 2) })).toBe(
      [
        `INSERT INTO "items" ("id", "name", "price") VALUES (1, 'alice', 9.90);`,
        `INSERT INTO "items" ("id", "name", "price") VALUES (2, 'o''brien', NULL);`,
      ].join('\n'),
    );
  });

  it('quotes the way each database does', () => {
    expect(text({ format: 'insert', dialect: mysqlDialect, rows: [ROWS[1] ?? []] })).toContain(
      "INSERT INTO `items` (`id`, `name`, `price`) VALUES (2, 'o''brien', NULL);",
    );
    expect(
      text({
        format: 'insert',
        dialect: postgresDialect,
        edit: { ...EDIT, table: { schema: 'public', name: 'items' } },
        rows: [ROWS[0] ?? []],
      }),
    ).toContain('INSERT INTO "public"."items"');
  });

  it('keeps a backslash safe for MySQL', () => {
    expect(text({ format: 'insert', dialect: mysqlDialect, rows: [[1, 'a\\b', null]] })).toContain(
      "'a\\\\b'",
    );
  });

  it('writes only the selected columns, using the table names behind them', () => {
    expect(
      text({
        format: 'insert',
        left: 1,
        right: 1,
        rows: [ROWS[0] ?? []],
        edit: { ...EDIT, columnMap: ['id', 'real_name', 'price'] },
      }),
    ).toBe(`INSERT INTO "items" ("real_name") VALUES ('alice');`);
  });

  it('skips computed columns, and refuses when nothing is left', () => {
    const edit: EditableResult = { ...EDIT, columnMap: ['id', null, 'price'] };
    expect(text({ format: 'insert', rows: [ROWS[0] ?? []], edit })).toContain('("id", "price")');
    expect(copyAs(input({ format: 'insert', left: 1, right: 1, edit }))).toEqual({
      ok: false,
      error: 'nothing-to-write',
    });
  });

  it('uses a placeholder table for a result that is not one plain table', () => {
    expect(text({ format: 'insert', edit: undefined, rows: [ROWS[0] ?? []] })).toContain(
      `INSERT INTO "${PLACEHOLDER_TABLE}" ("id", "name", "price")`,
    );
  });

  it('writes the full bytes of a blob, not just its preview', () => {
    const bytes = new Uint8Array(300).fill(0xab);
    const value = binaryValue(bytes);
    const sql = text({ format: 'insert', rows: [[1, value, null]] });
    expect(sql).toContain(`x'${'ab'.repeat(300)}'`);
  });

  it('refuses without rows or without a dialect', () => {
    expect(copyAs(input({ format: 'insert', rows: [] }))).toEqual({
      ok: false,
      error: 'nothing-to-write',
    });
    expect(copyAs(input({ format: 'insert', dialect: undefined }))).toEqual({
      ok: false,
      error: 'nothing-to-write',
    });
  });
});

describe('copyAs UPDATE', () => {
  it('sets the selected non-key columns and finds the row by its key', () => {
    expect(text({ format: 'update', left: 1, right: 2, rows: ROWS.slice(0, 2) })).toBe(
      [
        `UPDATE "items" SET "name" = 'alice', "price" = 9.90 WHERE "id" = 1;`,
        `UPDATE "items" SET "name" = 'o''brien', "price" = NULL WHERE "id" = 2;`,
      ].join('\n'),
    );
  });

  it('takes the key from the row even when it is not selected, and leaves it out of SET', () => {
    const sql = text({ format: 'update', left: 0, right: 1, rows: [ROWS[0] ?? []] });
    expect(sql).toBe(`UPDATE "items" SET "name" = 'alice' WHERE "id" = 1;`);
  });

  it('combines every part of a composite key', () => {
    const edit: EditableResult = {
      ...EDIT,
      keyColumns: ['id', 'name'],
      keyIndexes: [0, 1],
    };
    expect(text({ format: 'update', left: 2, right: 2, rows: [ROWS[0] ?? []], edit })).toBe(
      `UPDATE "items" SET "price" = 9.90 WHERE "id" = 1 AND "name" = 'alice';`,
    );
  });

  it('refuses a result that is not editable', () => {
    expect(copyAs(input({ format: 'update', edit: undefined }))).toEqual({
      ok: false,
      error: 'no-key',
    });
    expect(
      copyAs(input({ format: 'update', edit: { editable: false, reason: 'multiple-tables' } })),
    ).toEqual({
      ok: false,
      error: 'no-key',
    });
  });

  it('refuses when only the key is selected', () => {
    expect(copyAs(input({ format: 'update', left: 0, right: 0 }))).toEqual({
      ok: false,
      error: 'nothing-to-write',
    });
  });
});

describe('copyAs IN list', () => {
  it('lists the first selected column as literals', () => {
    expect(text({ format: 'in', left: 0, right: 0 })).toBe('(1, 2, 3)');
    expect(text({ format: 'in', left: 1, right: 2 })).toBe(`('alice', 'o''brien', 'a|b\nc')`);
  });

  it('drops NULLs and repeated values', () => {
    expect(text({ format: 'in', left: 0, right: 0, rows: [[1], [null], [1], [2], [null]] })).toBe(
      '(1, 2)',
    );
  });

  it("keeps 1 and '1' apart", () => {
    expect(text({ format: 'in', left: 0, right: 0, rows: [[1], ['1']] })).toBe("(1, '1')");
  });

  it('refuses a column of NULLs', () => {
    expect(copyAs(input({ format: 'in', left: 0, right: 0, rows: [[null], [null]] }))).toEqual({
      ok: false,
      error: 'no-values',
    });
  });
});

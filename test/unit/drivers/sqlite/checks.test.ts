import { describe, expect, it } from 'vitest';
import {
  isUnnamedSqliteCheck,
  parseSqliteChecks,
  sqliteChangeCheck,
  sqliteRebuildWith,
  sqliteTableOptions,
  withoutSqliteCheck,
  withSqliteCheck,
} from '../../../../src/drivers/sqlite/checks';
import type { TableStructure } from '../../../../src/core/model/objects';

const PRODUCTS = `CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  price REAL NOT NULL CHECK (price > 0),
  qty INTEGER,
  CONSTRAINT qty_positive CHECK (qty >= 0),
  CHECK (price < 1000000)
)`;

function structure(createSql: string, extra: Partial<TableStructure> = {}): TableStructure {
  return {
    columns: [
      { name: 'id', dataType: 'INTEGER', nullable: false, autoIncrement: false, generated: false },
      { name: 'price', dataType: 'REAL', nullable: false, autoIncrement: false, generated: false },
    ],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    createSql,
    ...extra,
  };
}

describe('parseSqliteChecks', () => {
  it('finds column and table checks, named or not, in order', () => {
    expect(parseSqliteChecks(PRODUCTS)).toEqual([
      { name: 'unnamed_check_1', expression: '(price > 0)' },
      { name: 'qty_positive', expression: '(qty >= 0)' },
      { name: 'unnamed_check_2', expression: '(price < 1000000)' },
    ]);
  });

  it('is empty for a table without checks and for text that is not a table', () => {
    expect(parseSqliteChecks('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')).toEqual([]);
    expect(parseSqliteChecks('')).toEqual([]);
    expect(parseSqliteChecks('CREATE VIEW v AS SELECT 1')).toEqual([]);
    expect(parseSqliteChecks('CREATE TABLE t')).toEqual([]);
  });

  it('keeps parentheses inside strings and nested ones in the condition', () => {
    const sql = `CREATE TABLE t (
      a TEXT CHECK (a NOT IN (')', '(', 'x''y') AND length(a) < (SELECT 10)),
      b INT CHECK (((b)))
    )`;
    expect(parseSqliteChecks(sql)).toEqual([
      {
        name: 'unnamed_check_1',
        expression: "(a NOT IN (')', '(', 'x''y') AND length(a) < (SELECT 10))",
      },
      { name: 'unnamed_check_2', expression: '(((b)))' },
    ]);
  });

  it('ignores the word CHECK in strings, comments, defaults and quoted names', () => {
    const sql = `CREATE TABLE t (
      "check" INT,
      -- CHECK (a > 1)
      /* CHECK (b > 1) */
      note TEXT DEFAULT 'CHECK (x > 1)',
      \`check (y)\` INT,
      c INT CHECK (c > 0)
    )`;
    expect(parseSqliteChecks(sql)).toEqual([{ name: 'unnamed_check_1', expression: '(c > 0)' }]);
  });

  it('reads names quoted with double quotes, backticks and brackets', () => {
    const sql = `CREATE TABLE t (
      a INT,
      CONSTRAINT "a positive" CHECK (a > 0),
      CONSTRAINT \`b\` CHECK (a < 9),
      CONSTRAINT [c d] CHECK (a <> 5)
    )`;
    expect(parseSqliteChecks(sql).map((check) => check.name)).toEqual(['a positive', 'b', 'c d']);
  });

  it('reads a table inside a schema, with IF NOT EXISTS and options after the list', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS main.t (id INTEGER PRIMARY KEY, CHECK (id > 0)) WITHOUT ROWID';
    expect(parseSqliteChecks(sql)).toEqual([{ name: 'unnamed_check_1', expression: '(id > 0)' }]);
  });

  it('does not take a check of a foreign key clause or a default expression for its own', () => {
    const sql = `CREATE TABLE t (
      a INT REFERENCES o(id) CHECK (a > 0) DEFAULT (CASE WHEN 1 THEN 2 ELSE 3 END),
      b INT DEFAULT (abs(-1))
    )`;
    expect(parseSqliteChecks(sql)).toEqual([{ name: 'unnamed_check_1', expression: '(a > 0)' }]);
  });
});

describe('withoutSqliteCheck', () => {
  it('drops a named table constraint in the middle with its comma', () => {
    expect(withoutSqliteCheck(PRODUCTS, 'qty_positive')).toBe(`CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  price REAL NOT NULL CHECK (price > 0),
  qty INTEGER,
  CHECK (price < 1000000)
)`);
  });

  it('drops the last item together with the comma before it', () => {
    expect(withoutSqliteCheck(PRODUCTS, 'unnamed_check_2')).toBe(`CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  price REAL NOT NULL CHECK (price > 0),
  qty INTEGER,
  CONSTRAINT qty_positive CHECK (qty >= 0)
)`);
  });

  it('drops a check that is part of a column and leaves the column', () => {
    expect(withoutSqliteCheck(PRODUCTS, 'unnamed_check_1')).toContain(
      'price REAL NOT NULL,\n  qty INTEGER',
    );
  });

  it('drops a named check of a column along with its CONSTRAINT word', () => {
    const sql = 'CREATE TABLE t (a INT CONSTRAINT pos CHECK (a > 0) NOT NULL)';
    expect(withoutSqliteCheck(sql, 'pos')).toBe('CREATE TABLE t (a INT NOT NULL)');
  });

  it('drops the only item that is a check', () => {
    expect(withoutSqliteCheck('CREATE TABLE t (CHECK (1))', 'unnamed_check_1')).toBe(
      'CREATE TABLE t ()',
    );
  });

  it('says not-found for a name it does not have', () => {
    expect(() => withoutSqliteCheck(PRODUCTS, 'nope')).toThrow(/does not exist/);
    expect(() => withoutSqliteCheck('nonsense', 'x')).toThrow();
  });
});

describe('withSqliteCheck', () => {
  it('adds a named table constraint after the last item, before the closing parenthesis', () => {
    expect(withSqliteCheck('CREATE TABLE t (\n  a INT,\n  b INT\n)', 'ab', 'a < b')).toBe(
      'CREATE TABLE t (\n  a INT,\n  b INT,\n  CONSTRAINT "ab" CHECK (a < b)\n)',
    );
  });

  it('keeps table options and a trailing comment where they were', () => {
    expect(withSqliteCheck('CREATE TABLE t (a INT) WITHOUT ROWID', 'pos', 'CHECK (a > 0)')).toBe(
      'CREATE TABLE t (a INT,\n  CONSTRAINT "pos" CHECK (a > 0)) WITHOUT ROWID',
    );
  });

  it('wraps a condition that is not one parenthesis, and leaves one that is', () => {
    expect(withSqliteCheck('CREATE TABLE t (a INT)', 'x', '(a > 0) AND (a < 9)')).toContain(
      'CHECK ((a > 0) AND (a < 9))',
    );
    expect(withSqliteCheck('CREATE TABLE t (a INT)', 'x', "(a <> ')')")).toContain(
      `CHECK (a <> ')')`,
    );
  });

  it('refuses a name that is taken and text that is not a table', () => {
    expect(() => withSqliteCheck(PRODUCTS, 'qty_positive', 'qty > 1')).toThrow(/exists already/);
    expect(() => withSqliteCheck('SELECT 1', 'x', 'a > 0')).toThrow();
  });

  it('round-trips with the parser', () => {
    const added = withSqliteCheck(PRODUCTS, 'qty_small', 'qty < 100');
    expect(parseSqliteChecks(added).map((check) => check.name)).toEqual([
      'unnamed_check_1',
      'qty_positive',
      'unnamed_check_2',
      'qty_small',
    ]);
    expect(parseSqliteChecks(withoutSqliteCheck(added, 'qty_small'))).toEqual(
      parseSqliteChecks(PRODUCTS),
    );
  });
});

describe('sqliteRebuildWith', () => {
  it('copies the table under a new name, swaps them and creates the dependents again', () => {
    const plan = sqliteChangeCheck(
      { name: 'products' },
      structure(PRODUCTS, {
        dependents: [
          { kind: 'index', name: 'ix_price', sql: 'CREATE INDEX ix_price ON products (price)' },
        ],
      }),
      { action: 'drop', name: 'qty_positive' },
    );
    expect(plan.statements[0]).toBe('PRAGMA foreign_keys = OFF');
    expect(plan.statements[1]).toBe('BEGIN');
    expect(plan.statements[3]).toMatch(/^CREATE TABLE "products__datanest_rebuild" \(/);
    expect(plan.statements[3]).not.toContain('qty_positive');
    expect(plan.statements).toContain(
      'INSERT INTO "products__datanest_rebuild" ("id", "price") SELECT "id", "price" FROM "products"',
    );
    expect(plan.statements).toContain('DROP TABLE "products"');
    expect(plan.statements).toContain(
      'ALTER TABLE "products__datanest_rebuild" RENAME TO "products"',
    );
    expect(plan.statements.slice(-2)).toEqual([
      'CREATE INDEX ix_price ON products (price)',
      'COMMIT',
    ]);
    expect(plan.notes).toEqual(['rebuild']);
    expect(plan.recovery).toContain('ROLLBACK');
  });

  it('does not copy computed columns, and names the table inside an attached database', () => {
    const plan = sqliteRebuildWith(
      { database: 'aux', name: 't' },
      structure('CREATE TABLE IF NOT EXISTS aux.t (a INT, b INT AS (a + 1))', {
        columns: [
          { name: 'a', dataType: 'INT', nullable: true, autoIncrement: false, generated: false },
          { name: 'b', dataType: 'INT', nullable: true, autoIncrement: false, generated: true },
        ],
      }),
      'CREATE TABLE IF NOT EXISTS aux.t (a INT, b INT AS (a + 1))',
    );
    expect(plan.statements[3]).toBe(
      'CREATE TABLE "aux"."t__datanest_rebuild" (a INT, b INT AS (a + 1))',
    );
    expect(plan.statements).toContain(
      'INSERT INTO "aux"."t__datanest_rebuild" ("a") SELECT "a" FROM "aux"."t"',
    );
  });

  it('needs the stored text', () => {
    expect(() =>
      sqliteChangeCheck(
        { name: 't' },
        { ...structure(''), createSql: undefined },
        {
          action: 'drop',
          name: 'x',
        },
      ),
    ).toThrow(/definition/);
    expect(() => sqliteRebuildWith({ name: 't' }, structure(''), 'nonsense')).toThrow(/definition/);
  });
});

describe('sqliteTableOptions and isUnnamedSqliteCheck', () => {
  it('reads what follows the column list', () => {
    expect(sqliteTableOptions('CREATE TABLE t (a INT PRIMARY KEY) WITHOUT ROWID;')).toBe(
      'WITHOUT ROWID',
    );
    expect(sqliteTableOptions('CREATE TABLE t (a INT) STRICT, WITHOUT ROWID')).toBe(
      'STRICT, WITHOUT ROWID',
    );
    expect(sqliteTableOptions('CREATE TABLE t (a INT CHECK (a > (1)))')).toBe('');
    expect(sqliteTableOptions('not a table')).toBe('');
  });

  it('knows the label of a check without a name', () => {
    expect(isUnnamedSqliteCheck('unnamed_check_12')).toBe(true);
    expect(isUnnamedSqliteCheck('unnamed_check_x')).toBe(false);
    expect(isUnnamedSqliteCheck('qty_ok')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import { buildOrderBy, buildWhere, escapeLike } from '../../../src/services/table-filter-sql';
import type { TableFilter } from '../../../src/shared/table-filter';

const filter = (...conditions: TableFilter['conditions']): TableFilter => ({ conditions });

describe('buildWhere', () => {
  it('is undefined for an empty filter', () => {
    expect(buildWhere(sqliteDialect, 'sqlite', undefined)).toBeUndefined();
    expect(buildWhere(sqliteDialect, 'sqlite', { conditions: [], where: ' ' })).toBeUndefined();
  });

  it('compares through quoted names and literals', () => {
    const sql = buildWhere(
      postgresDialect,
      'postgres',
      filter(
        { column: 'id', operator: 'eq', value: '5' },
        { column: 'name', operator: 'ne', value: 'bob' },
        { column: 'age', operator: 'ge', value: '18' },
      ),
    );
    expect(sql).toBe(`"id" = '5' AND "name" <> 'bob' AND "age" >= '18'`);
  });

  it('checks for NULL without a value', () => {
    expect(
      buildWhere(
        mysqlDialect,
        'mysql',
        filter({ column: 'a', operator: 'isNull' }, { column: 'b', operator: 'notNull' }),
      ),
    ).toBe('`a` IS NULL AND `b` IS NOT NULL');
  });

  it('keeps quotes in values and names from breaking out', () => {
    const sql = buildWhere(
      sqliteDialect,
      'sqlite',
      filter({ column: 'we"ird', operator: 'eq', value: "x' OR '1'='1" }),
    );
    expect(sql).toBe(`"we""ird" = 'x'' OR ''1''=''1'`);
  });

  it('escapes backslashes the way MySQL reads them', () => {
    expect(
      buildWhere(mysqlDialect, 'mysql', filter({ column: 'p', operator: 'eq', value: "a\\'b" })),
    ).toBe("`p` = 'a\\\\''b'");
  });

  it('builds LIKE patterns with wildcards escaped', () => {
    const contains = buildWhere(
      sqliteDialect,
      'sqlite',
      filter({ column: 'n', operator: 'contains', value: '50%_off!' }),
    );
    expect(contains).toBe(`CAST("n" AS TEXT) LIKE '%50!%!_off!!%' ESCAPE '!'`);
    expect(
      buildWhere(
        sqliteDialect,
        'sqlite',
        filter({ column: 'n', operator: 'startsWith', value: 'a' }),
      ),
    ).toContain(`LIKE 'a%'`);
    expect(
      buildWhere(
        sqliteDialect,
        'sqlite',
        filter({ column: 'n', operator: 'endsWith', value: 'a' }),
      ),
    ).toContain(`LIKE '%a'`);
  });

  it('negates "does not contain" as a whole', () => {
    expect(
      buildWhere(
        sqliteDialect,
        'sqlite',
        filter({ column: 'n', operator: 'notContains', value: 'x' }),
      ),
    ).toBe(`NOT (CAST("n" AS TEXT) LIKE '%x%' ESCAPE '!')`);
  });

  it('matches text case-insensitively on PostgreSQL and casts numbers to text', () => {
    expect(
      buildWhere(
        postgresDialect,
        'postgres',
        filter({ column: 'n', operator: 'contains', value: 'x' }),
      ),
    ).toBe(`CAST("n" AS TEXT) ILIKE '%x%' ESCAPE '!'`);
    expect(
      buildWhere(mysqlDialect, 'mysql', filter({ column: 'n', operator: 'contains', value: 'x' })),
    ).toBe("CAST(`n` AS CHAR) LIKE '%x%' ESCAPE '!'");
  });

  it('adds the hand-written WHERE on its own lines in parentheses', () => {
    expect(
      buildWhere(sqliteDialect, 'sqlite', {
        conditions: [{ column: 'a', operator: 'isNull' }],
        where: ' price > 10 -- cheap ',
      }),
    ).toBe('"a" IS NULL AND (\nprice > 10 -- cheap\n)');
  });

  it('uses the hand-written WHERE alone when there are no conditions', () => {
    expect(buildWhere(sqliteDialect, 'sqlite', { conditions: [], where: 'a = 1' })).toBe(
      '(\na = 1\n)',
    );
  });

  it('allows a semicolon inside a string or a comment, not as a separator', () => {
    expect(() =>
      buildWhere(sqliteDialect, 'sqlite', { conditions: [], where: "a = 'x;y' -- ; fine" }),
    ).not.toThrow();
    expect(() =>
      buildWhere(sqliteDialect, 'sqlite', { conditions: [], where: '1=1; DROP TABLE t' }),
    ).toThrow(DbError);
  });

  it('refuses text with an unclosed quote or comment', () => {
    expect(() =>
      buildWhere(sqliteDialect, 'sqlite', { conditions: [], where: "a = 'oops" }),
    ).toThrow('unclosed');
    expect(() =>
      buildWhere(sqliteDialect, 'sqlite', { conditions: [], where: 'a = 1 /* oops' }),
    ).toThrow('unclosed');
  });

  it('knows MySQL treats a backslash as an escape inside strings', () => {
    // On MySQL the quote after the backslash does not end the string, so it is unclosed.
    expect(() => buildWhere(mysqlDialect, 'mysql', { conditions: [], where: "a = 'x\\'" })).toThrow(
      'unclosed',
    );
    expect(() =>
      buildWhere(sqliteDialect, 'sqlite', { conditions: [], where: "a = 'x\\'" }),
    ).not.toThrow();
  });
});

describe('escapeLike', () => {
  it('escapes the wildcards and the escape character itself', () => {
    expect(escapeLike('a%b_c!d')).toBe('a!%b!_c!!d');
    expect(escapeLike('plain')).toBe('plain');
    expect(escapeLike('')).toBe('');
  });
});

describe('buildOrderBy', () => {
  it('quotes the column and spells the direction', () => {
    expect(buildOrderBy(sqliteDialect, { column: 'a"b', direction: 'desc' })).toBe('"a""b" DESC');
    expect(buildOrderBy(mysqlDialect, { column: 'id', direction: 'asc' })).toBe('`id` ASC');
  });

  it('is undefined without a sort', () => {
    expect(buildOrderBy(sqliteDialect, undefined)).toBeUndefined();
  });
});

describe('buildWhere with OR', () => {
  const eq = (column: string, value: string, join?: 'and' | 'or') => ({
    column,
    operator: 'eq' as const,
    value,
    ...(join === undefined ? {} : { join }),
  });

  it('groups the conditions that follow an OR, as SQL reads them', () => {
    const sql = buildWhere(
      postgresDialect,
      'postgres',
      filter(eq('a', '1'), eq('b', '2'), eq('c', '3', 'or')),
    );
    expect(sql).toBe(`(("a" = '1' AND "b" = '2') OR "c" = '3')`);
  });

  it('joins single conditions with OR and keeps AND for the rest', () => {
    expect(
      buildWhere(
        mysqlDialect,
        'mysql',
        filter(eq('a', '1'), eq('b', '2', 'or'), eq('c', '3', 'or')),
      ),
    ).toBe("(`a` = '1' OR `b` = '2' OR `c` = '3')");
    expect(buildWhere(mysqlDialect, 'mysql', filter(eq('a', '1'), eq('b', '2', 'and')))).toBe(
      "`a` = '1' AND `b` = '2'",
    );
  });

  it('ignores the join of the first condition', () => {
    expect(buildWhere(sqliteDialect, 'sqlite', filter(eq('a', '1', 'or'), eq('b', '2')))).toBe(
      `"a" = '1' AND "b" = '2'`,
    );
  });

  it('keeps a hand-written WHERE ANDed to the whole OR group', () => {
    const sql = buildWhere(postgresDialect, 'postgres', {
      conditions: [eq('a', '1'), eq('b', '2', 'or')],
      where: 'c > 3',
    });
    expect(sql).toBe(`("a" = '1' OR "b" = '2') AND (\nc > 3\n)`);
  });

  it('quotes values and names inside an OR just the same', () => {
    expect(
      buildWhere(
        postgresDialect,
        'postgres',
        filter(eq('a"b', "o'k"), eq('c', "x'; DROP TABLE t; --", 'or')),
      ),
    ).toBe(`("a""b" = 'o''k' OR "c" = 'x''; DROP TABLE t; --')`);
  });
});

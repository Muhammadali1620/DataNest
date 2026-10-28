import { describe, expect, it } from 'vitest';
import { derivedTables, selectListOf } from '../../../../src/core/sql/derived-tables';
import { isTrivia, tokenize } from '../../../../src/core/sql/tokenizer';

function tables(sql: string) {
  return derivedTables(sql, tokenize(sql));
}

function list(sql: string) {
  return selectListOf(
    sql,
    tokenize(sql).filter((token) => !isTrivia(token)),
  );
}

describe('selectListOf', () => {
  it('names columns, aliases with and without AS, and qualified columns', () => {
    expect(
      list('SELECT id, o.total, price * 2 AS doubled, count(*) n, name label FROM t').columns,
    ).toEqual(['id', 'total', 'doubled', 'n', 'label']);
  });

  it('skips expressions without a name of their own', () => {
    expect(list('SELECT count(*), a + b, 1 FROM t').columns).toEqual([]);
  });

  it('reads quoted names and CASE … END aliases', () => {
    expect(list('SELECT "Full Name", CASE WHEN a THEN 1 END flag FROM t').columns).toEqual([
      'Full Name',
      'flag',
    ]);
  });

  it('notices * and t.*', () => {
    expect(list('SELECT * FROM t').star).toBe('all');
    expect(list('SELECT a.*, b.x FROM a JOIN b ON true')).toEqual({ columns: ['x'], star: ['a'] });
  });

  it('stops at FROM and ignores nested selects and DISTINCT', () => {
    expect(list('SELECT DISTINCT a, (SELECT max(x) FROM y) AS m FROM t').columns).toEqual([
      'a',
      'm',
    ]);
  });

  it('has nothing without a SELECT', () => {
    expect(list('UPDATE t SET a = 1')).toEqual({ columns: [], star: undefined });
  });
});

describe('derivedTables', () => {
  it('reads CTEs with their columns', () => {
    expect(
      tables(
        'WITH big AS (SELECT id, total FROM orders WHERE total > 9), b2 AS (SELECT id x FROM b) SELECT * FROM big',
      ),
    ).toEqual([
      { name: 'big', columns: ['id', 'total'], starFrom: [] },
      { name: 'b2', columns: ['x'], starFrom: [] },
    ]);
  });

  it('prefers a declared column list and reads RECURSIVE and MATERIALIZED', () => {
    expect(
      tables(
        'WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n), m AS MATERIALIZED (SELECT a FROM t) SELECT v FROM n',
      ),
    ).toEqual([
      { name: 'n', columns: ['v'], starFrom: [] },
      { name: 'm', columns: ['a'], starFrom: [] },
    ]);
  });

  it('remembers which tables a star brings in', () => {
    expect(tables('WITH x AS (SELECT * FROM orders o JOIN customers c ON true) SELECT 1')).toEqual([
      {
        name: 'x',
        columns: [],
        starFrom: [
          { name: 'orders', alias: 'o' },
          { name: 'customers', alias: 'c' },
        ],
      },
    ]);
    expect(
      tables('WITH x AS (SELECT c.*, o.id FROM orders o JOIN customers c ON true) SELECT 1')[0],
    ).toEqual({
      name: 'x',
      columns: ['id'],
      starFrom: [{ name: 'customers', alias: 'c' }],
    });
  });

  it('reads subqueries in FROM and JOIN with their aliases', () => {
    expect(
      tables(
        'SELECT * FROM (SELECT id, total FROM orders) AS o JOIN (SELECT id AS cid FROM customers) c ON c.cid = o.id',
      ),
    ).toEqual([
      { name: 'o', columns: ['id', 'total'], starFrom: [] },
      { name: 'c', columns: ['cid'], starFrom: [] },
    ]);
  });

  it('ignores a subquery without an alias, in WHERE, or a broken WITH', () => {
    expect(tables('SELECT * FROM (SELECT 1 a)')).toEqual([]);
    expect(tables('SELECT * FROM t WHERE id IN (SELECT id FROM u) AND x')).toEqual([]);
    expect(tables('WITH x SELECT 1')).toEqual([]);
    expect(tables('WITH x AS SELECT 1')).toEqual([]);
    expect(tables('WITH x AS (SELECT a FROM t')).toEqual([
      { name: 'x', columns: ['a'], starFrom: [] },
    ]);
  });

  it('is not fooled by comments', () => {
    expect(tables('WITH /* x */ y AS ( -- note\n SELECT a FROM t) SELECT 1')).toEqual([
      { name: 'y', columns: ['a'], starFrom: [] },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { guessErrorPosition } from '../../../../src/core/sql/error-position';

describe('guessErrorPosition', () => {
  it('reads the MySQL "near … at line N" of a syntax error', () => {
    const sql = 'SELECT id,\n  nme FROM t\nWHER id = 1';
    const message =
      "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'WHER id = 1' at line 3";
    expect(guessErrorPosition(message, sql, 'mysql')).toBe(sql.indexOf('WHER'));
  });

  it('finds a long fragment by its beginning, from the right line on', () => {
    const sql = 'SELECT 1;\nSELECT x FROM t WHERE a = 1 AND b = 2 AND c = 3 AND d = 4 AND e = 5';
    const fragment = 'FROM t WHERE a = 1 AND b = 2 AND c = 3 AND d = 4 AN';
    expect(guessErrorPosition(`... near '${fragment}' at line 2`, sql, 'mysql')).toBe(
      sql.indexOf('FROM t'),
    );
  });

  it('points past the end when MySQL says near nothing', () => {
    expect(guessErrorPosition("... near '' at line 1", 'SELECT * FROM  ', 'mysql')).toBe(13);
  });

  it('reads the SQLite "near …: syntax error"', () => {
    expect(guessErrorPosition('near "SELEC": syntax error', 'SELEC 1', 'sqlite')).toBe(0);
    expect(guessErrorPosition('near "FROM": syntax error', 'SELECT a, FROM t', 'sqlite')).toBe(10);
    expect(guessErrorPosition('incomplete input', 'SELECT (', 'sqlite')).toBeUndefined();
  });

  it('finds the missing column, table or function in the statement', () => {
    const sql = 'SELECT nme FROM orders o WHERE o.ttl > 1';
    expect(guessErrorPosition('no such column: nme', sql, 'sqlite')).toBe(7);
    expect(guessErrorPosition('no such column: o.ttl', sql, 'sqlite')).toBe(sql.indexOf('ttl'));
    expect(guessErrorPosition("Unknown column 'o.ttl' in 'where clause'", sql, 'mysql')).toBe(
      sql.indexOf('ttl'),
    );
    expect(guessErrorPosition("Table 'shop.orders' doesn't exist", sql, 'mysql')).toBe(16);
    expect(guessErrorPosition('relation "public.orders" does not exist', sql, 'postgres')).toBe(16);
  });

  it('matches names case-insensitively and inside quotes, never inside strings', () => {
    expect(
      guessErrorPosition('no such column: Name', 'SELECT \'name\', "name" FROM t', 'sqlite'),
    ).toBe(15);
  });

  it('says nothing for messages it does not know or names it cannot find', () => {
    expect(
      guessErrorPosition('Duplicate entry', 'INSERT INTO t VALUES (1)', 'mysql'),
    ).toBeUndefined();
    expect(guessErrorPosition('no such table: gone', 'SELECT 1', 'sqlite')).toBeUndefined();
  });
});

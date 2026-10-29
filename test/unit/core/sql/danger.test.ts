import { describe, expect, it } from 'vitest';
import { dangersOf } from '../../../../src/core/sql/danger';
import { syntaxOf } from '../../../../src/core/sql/tokenizer';

const mysql = syntaxOf('mysql');
const postgres = syntaxOf('postgres');

describe('dangersOf: DELETE and UPDATE', () => {
  it('flags a DELETE or UPDATE with no WHERE', () => {
    expect(dangersOf('DELETE FROM users')).toEqual(['delete-without-where']);
    expect(dangersOf('UPDATE users SET active = 0')).toEqual(['update-without-where']);
  });

  it('lets one with a WHERE through', () => {
    expect(dangersOf('DELETE FROM users WHERE id = 1')).toEqual([]);
    expect(dangersOf('UPDATE users SET active = 0 WHERE id = 1')).toEqual([]);
  });

  it('is not case sensitive and ignores whitespace and comments around it', () => {
    expect(dangersOf('  -- cleanup\n  delete\n  from users /* all */ ;')).toEqual([
      'delete-without-where',
    ]);
    expect(dangersOf('/* x */ update users set a=1 where b=2')).toEqual([]);
  });

  it("does not take a WHERE inside a subquery for the statement's own", () => {
    expect(dangersOf('DELETE FROM users USING (SELECT id FROM t WHERE x = 1) s')).toEqual([
      'delete-without-where',
    ]);
    expect(dangersOf('UPDATE users SET a = (SELECT b FROM t WHERE t.id = 1)')).toEqual([
      'update-without-where',
    ]);
  });

  it('accepts a WHERE after a subquery, and a subquery inside the WHERE', () => {
    expect(dangersOf('DELETE FROM users WHERE id IN (SELECT id FROM banned WHERE x = 1)')).toEqual(
      [],
    );
    expect(dangersOf('UPDATE users SET a = (SELECT 1) WHERE id = 1')).toEqual([]);
  });

  it('does not take the word WHERE in a string, a comment or a name for a condition', () => {
    expect(dangersOf('DELETE FROM users -- WHERE id = 1')).toEqual(['delete-without-where']);
    expect(dangersOf("UPDATE t SET note = 'where am i'")).toEqual(['update-without-where']);
    expect(dangersOf('DELETE FROM "where"')).toEqual(['delete-without-where']);
    expect(dangersOf('DELETE FROM `where`', mysql)).toEqual(['delete-without-where']);
    expect(dangersOf('DELETE FROM somewhere')).toEqual(['delete-without-where']);
  });

  it('knows a MySQL multi-table DELETE and a LIMIT do not replace a WHERE', () => {
    expect(dangersOf('DELETE a FROM a JOIN b ON a.id = b.id', mysql)).toEqual([
      'delete-without-where',
    ]);
    expect(dangersOf('DELETE FROM logs ORDER BY id LIMIT 10', mysql)).toEqual([
      'delete-without-where',
    ]);
    expect(dangersOf('DELETE FROM a USING a JOIN b ON a.id = b.id WHERE b.x = 1', mysql)).toEqual(
      [],
    );
  });

  it('does not flag an upsert whose update has no WHERE', () => {
    expect(
      dangersOf(
        'INSERT INTO t (id, a) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET a = 3',
        postgres,
      ),
    ).toEqual([]);
    expect(dangersOf('INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 3', mysql)).toEqual([]);
  });
});

describe('dangersOf: structure', () => {
  it('flags DROP of anything and TRUNCATE', () => {
    expect(dangersOf('DROP TABLE users')).toEqual(['drop']);
    expect(dangersOf('drop database app')).toEqual(['drop']);
    expect(dangersOf('DROP INDEX IF EXISTS idx')).toEqual(['drop']);
    expect(dangersOf('TRUNCATE TABLE users')).toEqual(['truncate']);
    expect(dangersOf('truncate users')).toEqual(['truncate']);
  });

  it('does not flag CREATE, ALTER, INSERT or SELECT', () => {
    for (const sql of [
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD COLUMN a int',
      'INSERT INTO t VALUES (1)',
      'SELECT * FROM t',
      'SELECT 1 FROM t WHERE x = 1',
      'SHOW TABLES',
    ]) {
      expect(dangersOf(sql)).toEqual([]);
    }
  });

  it('does not look inside a string that mentions a dangerous verb', () => {
    expect(dangersOf("SELECT 'DROP TABLE users'")).toEqual([]);
    expect(dangersOf("INSERT INTO log VALUES ('DELETE FROM users')")).toEqual([]);
  });

  it('ignores a commented-out verb', () => {
    expect(dangersOf('-- DROP TABLE users\nSELECT 1')).toEqual([]);
    expect(dangersOf('/* DROP TABLE users */')).toEqual([]);
  });
});

describe('dangersOf: WITH and EXPLAIN', () => {
  it('looks through a WITH clause to the statement it feeds', () => {
    expect(dangersOf('WITH old AS (SELECT id FROM t WHERE x = 1) DELETE FROM t', postgres)).toEqual(
      ['delete-without-where'],
    );
    expect(
      dangersOf(
        'WITH old AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM old)',
        postgres,
      ),
    ).toEqual([]);
    expect(dangersOf('WITH a AS (SELECT 1) SELECT * FROM a', postgres)).toEqual([]);
    expect(dangersOf('WITH RECURSIVE r(n) AS (SELECT 1) UPDATE t SET a = 1', postgres)).toEqual([
      'update-without-where',
    ]);
  });

  it('does not mind a plain EXPLAIN, which does not run the statement', () => {
    expect(dangersOf('EXPLAIN DELETE FROM users')).toEqual([]);
    expect(dangersOf('EXPLAIN SELECT 1')).toEqual([]);
  });

  it('does mind EXPLAIN ANALYZE, which does', () => {
    expect(dangersOf('EXPLAIN ANALYZE DELETE FROM users', postgres)).toEqual([
      'delete-without-where',
    ]);
    expect(dangersOf('EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1', postgres)).toEqual([
      'update-without-where',
    ]);
    expect(dangersOf('EXPLAIN ANALYZE DELETE FROM users WHERE id = 1', postgres)).toEqual([]);
  });
});

describe('dangersOf: odd input', () => {
  it('is quiet about nothing, comments or punctuation', () => {
    for (const sql of ['', '   ', '-- just a note', ';', '()', '123']) {
      expect(dangersOf(sql)).toEqual([]);
    }
  });

  it('copes with an unterminated string or comment', () => {
    expect(dangersOf("DELETE FROM t WHERE a = 'oops")).toEqual([]);
    expect(dangersOf('DELETE FROM t /* WHERE a = 1')).toEqual(['delete-without-where']);
  });

  it('copes with unbalanced parentheses', () => {
    expect(dangersOf('DELETE FROM t ) WHERE a = 1')).toEqual([]);
    expect(dangersOf('DELETE FROM t WHERE (a = 1')).toEqual([]);
  });

  it('reads a dollar-quoted body as text on PostgreSQL', () => {
    expect(dangersOf('SELECT $$DROP TABLE x$$', postgres)).toEqual([]);
  });
});

describe('dangersOf: T-SQL batches (V6.2)', () => {
  const mssql = syntaxOf('mssql');

  it('finds a DROP or a DELETE without WHERE anywhere in the batch', () => {
    expect(dangersOf('DECLARE @n INT = 1;\nDROP TABLE t;', mssql)).toEqual(['drop']);
    expect(dangersOf('DECLARE @n INT;\nSELECT 1;\nDELETE FROM t;', mssql)).toEqual([
      'delete-without-where',
    ]);
    expect(dangersOf('BEGIN SELECT 1; UPDATE t SET a = 1; TRUNCATE TABLE u; END', mssql)).toEqual([
      'update-without-where',
      'truncate',
    ]);
  });

  it('reports each danger once, in the usual order', () => {
    expect(dangersOf('TRUNCATE TABLE a; DROP TABLE b; DROP TABLE c', mssql)).toEqual([
      'drop',
      'truncate',
    ]);
  });

  it('sees the WHERE of each part and ignores semicolons in strings and parentheses', () => {
    expect(dangersOf("DELETE FROM t WHERE a = ';'; SELECT 1", mssql)).toEqual([]);
    expect(dangersOf('DELETE t WHERE id IN (SELECT 1; )', mssql)).toEqual([]);
    expect(dangersOf('DELETE customers', mssql)).toEqual(['delete-without-where']);
  });

  it('looks past BEGIN, IF, WHILE, ELSE and TRY blocks to the statement inside', () => {
    expect(dangersOf('BEGIN UPDATE t SET a = 1; TRUNCATE TABLE u; END', mssql)).toEqual([
      'update-without-where',
      'truncate',
    ]);
    expect(dangersOf('IF @x = 1 DELETE FROM t', mssql)).toEqual(['delete-without-where']);
    expect(dangersOf('IF EXISTS (SELECT 1 FROM t) DROP TABLE t', mssql)).toEqual(['drop']);
    expect(dangersOf('IF @x = 1 SELECT 1; ELSE DELETE FROM t;', mssql)).toEqual([
      'delete-without-where',
    ]);
    expect(
      dangersOf('BEGIN TRY DELETE FROM t; END TRY BEGIN CATCH SELECT 1; END CATCH', mssql),
    ).toEqual(['delete-without-where']);
    expect(dangersOf('WHILE @i < 3 BEGIN DELETE FROM t WHERE id = @i; END', mssql)).toEqual([]);
    expect(dangersOf('IF @x = 1', mssql)).toEqual([]);
  });

  it('does not count BEGIN TRAN as a block', () => {
    expect(dangersOf('BEGIN TRAN; DELETE FROM t; COMMIT', mssql)).toEqual(['delete-without-where']);
    expect(dangersOf('BEGIN TRANSACTION UPDATE t SET a = 1', mssql)).toEqual([]);
  });

  it('leaves the body of a procedure or trigger alone: creating it runs nothing', () => {
    expect(
      dangersOf('CREATE PROCEDURE p AS BEGIN SELECT 1; IF @a = 1 DELETE FROM t; END', mssql),
    ).toEqual([]);
    expect(dangersOf('ALTER TRIGGER tr ON t AFTER UPDATE AS DELETE FROM audit;', mssql)).toEqual(
      [],
    );
  });

  it('is empty for a harmless batch', () => {
    expect(dangersOf('DECLARE @n INT = 1;\nSELECT @n;', mssql)).toEqual([]);
    expect(dangersOf('', mssql)).toEqual([]);
  });
});

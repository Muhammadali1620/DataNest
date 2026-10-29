import { describe, expect, it } from 'vitest';
import { changingStatements, isReadOnlyStatement } from '../../../../src/core/sql/read-only';
import { syntaxOf } from '../../../../src/core/sql/tokenizer';

const reads = (sql: string, driver?: 'mysql' | 'postgres' | 'sqlite') =>
  isReadOnlyStatement(sql, syntaxOf(driver));

describe('isReadOnlyStatement', () => {
  it.each([
    'SELECT * FROM orders',
    "select id from t where note = 'DELETE everything'",
    'SELECT 1 -- UPDATE t SET x = 1',
    '/* INSERT */ SELECT count(*) FROM (SELECT * FROM t) AS s',
    'VALUES (1), (2)',
    'TABLE orders',
    'SHOW TABLES',
    'DESCRIBE orders',
    'DESC orders',
    'USE shop',
    'BEGIN',
    'START TRANSACTION READ ONLY',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT a',
    'RELEASE SAVEPOINT a',
    'END',
    'WITH big AS (SELECT * FROM orders) SELECT * FROM big',
    'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n',
    'EXPLAIN SELECT * FROM t',
    'EXPLAIN DELETE FROM t',
    'EXPLAIN ANALYZE SELECT * FROM t',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT 1',
    'SET search_path TO app',
    'SET NAMES utf8mb4',
    'SET @x = 1',
    '-- only a comment',
    '',
  ])('reads only: %s', (sql) => {
    expect(reads(sql)).toBe(true);
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET x = 1 WHERE id = 1',
    'DELETE FROM t WHERE id = 1',
    'REPLACE INTO t VALUES (1)',
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'CREATE TABLE t (id int)',
    'ALTER TABLE t ADD c int',
    'DROP TABLE t',
    'TRUNCATE t',
    'GRANT SELECT ON t TO u',
    'CALL refresh_all()',
    'DO $$ BEGIN DELETE FROM t; END $$',
    'COPY t FROM stdin',
    'VACUUM',
    'LOCK TABLE t',
    'SELECT * INTO backup FROM t',
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    'SELECT * FROM t FOR UPDATE',
    'SELECT * FROM t FOR SHARE',
    'SELECT * FROM t FOR NO KEY UPDATE',
    'SELECT * FROM t LOCK IN SHARE MODE',
    'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone',
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'WITH x AS (SELECT 1) UPDATE t SET a = 1',
    'EXPLAIN ANALYZE DELETE FROM t',
    'EXPLAIN ANALYZE CREATE TABLE x AS SELECT 1',
    'START TRANSACTION READ WRITE',
    'SET GLOBAL max_connections = 10',
    "SET PERSIST sql_mode = ''",
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    'SET default_transaction_read_only = off',
    'SET SESSION TRANSACTION READ WRITE',
    'RESET ALL',
    'unknown statement',
  ])('may change: %s', (sql) => {
    expect(reads(sql)).toBe(false);
  });

  it.each([
    ['PRAGMA table_info(orders)', true],
    ['PRAGMA main.index_list(orders)', true],
    ['PRAGMA user_version', true],
    ['PRAGMA foreign_keys', true],
    ['PRAGMA user_version = 3', false],
    ['PRAGMA journal_mode(WAL)', false],
    ['PRAGMA query_only = OFF', false],
    ['PRAGMA optimize', false],
    ['PRAGMA wal_checkpoint', false],
  ] as const)('reads SQLite %s as %s', (sql, expected) => {
    expect(reads(sql, 'sqlite')).toBe(expected);
  });

  it('respects the dialect when telling strings from code', () => {
    // In MySQL a backslash escapes the quote, so the DELETE is still inside the string.
    expect(reads("SELECT 'it\\'s; DELETE FROM t'", 'mysql')).toBe(true);
    expect(reads('SELECT `delete` FROM t', 'mysql')).toBe(true);
  });
});

describe('changingStatements', () => {
  it('keeps only the statements that may change something, in order', () => {
    const statements = [
      { text: 'SELECT 1', start: 0 },
      { text: 'UPDATE t SET a = 1', start: 10 },
      { text: 'SHOW TABLES', start: 30 },
      { text: 'DROP TABLE t', start: 45 },
    ];
    expect(changingStatements(statements).map((statement) => statement.start)).toEqual([10, 45]);
    expect(changingStatements([])).toEqual([]);
  });
});

describe('isReadOnlyStatement: T-SQL (V6.2)', () => {
  const mssql = syntaxOf('mssql');

  it('takes a bare BEGIN for a block that may write, BEGIN TRAN for a transaction', () => {
    expect(isReadOnlyStatement('BEGIN UPDATE t SET a = 1; END', mssql)).toBe(false);
    expect(isReadOnlyStatement('BEGIN', mssql)).toBe(false);
    expect(isReadOnlyStatement('BEGIN TRAN', mssql)).toBe(true);
    expect(isReadOnlyStatement('BEGIN TRANSACTION', mssql)).toBe(true);
    expect(isReadOnlyStatement('BEGIN DISTRIBUTED TRAN', mssql)).toBe(true);
    // Elsewhere BEGIN is the transaction itself.
    expect(isReadOnlyStatement('BEGIN', syntaxOf('postgres'))).toBe(true);
  });

  it('lets savepoints and PRINT through', () => {
    expect(isReadOnlyStatement('SAVE TRANSACTION s', mssql)).toBe(true);
    expect(isReadOnlyStatement('SAVE TRAN s', mssql)).toBe(true);
    expect(isReadOnlyStatement('SAVE x', mssql)).toBe(false);
    expect(isReadOnlyStatement("PRINT 'hi'", mssql)).toBe(true);
  });

  it('counts writes T-SQL hides: SELECT INTO, EXEC, a declaring batch', () => {
    expect(isReadOnlyStatement('SELECT TOP (5) * FROM [dbo].[t]', mssql)).toBe(true);
    expect(isReadOnlyStatement('SELECT * INTO #copy FROM t', mssql)).toBe(false);
    expect(isReadOnlyStatement('EXEC restock 1, 2', mssql)).toBe(false);
    expect(isReadOnlyStatement('DECLARE @n INT; DELETE FROM t', mssql)).toBe(false);
  });
});

describe('isReadOnlyStatement: ClickHouse (V6.3)', () => {
  const clickhouse = syntaxOf('clickhouse');

  it('reads with EXISTS, SHOW, DESCRIBE and SELECT … FINAL', () => {
    for (const sql of [
      'EXISTS TABLE t',
      'SHOW TABLES',
      'DESCRIBE TABLE t',
      'SELECT * FROM t FINAL WHERE a = 1',
    ]) {
      expect(isReadOnlyStatement(sql, clickhouse), sql).toBe(true);
    }
  });

  it('counts mutations, OPTIMIZE and SYSTEM as changes', () => {
    for (const sql of [
      'ALTER TABLE t DELETE WHERE a = 1',
      'OPTIMIZE TABLE t FINAL',
      'SYSTEM DROP DNS CACHE',
      'INSERT INTO t FORMAT JSONEachRow {}',
      'KILL QUERY WHERE 1',
    ]) {
      expect(isReadOnlyStatement(sql, clickhouse), sql).toBe(false);
    }
  });
});

describe('isReadOnlyStatement: Oracle (V6.4)', () => {
  const oracle = syntaxOf('oracle');

  it('takes BEGIN and DECLARE for PL/SQL blocks, which may write anything', () => {
    expect(isReadOnlyStatement('BEGIN NULL; END;', oracle)).toBe(false);
    expect(isReadOnlyStatement('BEGIN', oracle)).toBe(false);
    expect(isReadOnlyStatement('BEGIN TRAN', oracle)).toBe(false);
    expect(isReadOnlyStatement('DECLARE n NUMBER; BEGIN NULL; END;', oracle)).toBe(false);
  });

  it('keeps BEGIN a transaction elsewhere, and BEGIN TRAN one in T-SQL', () => {
    for (const driver of [undefined, 'mysql', 'postgres', 'sqlite'] as const) {
      expect(isReadOnlyStatement('BEGIN', syntaxOf(driver)), String(driver)).toBe(true);
    }
    expect(isReadOnlyStatement('BEGIN TRAN', syntaxOf('mssql'))).toBe(true);
    expect(isReadOnlyStatement('BEGIN', syntaxOf('mssql'))).toBe(false);
  });

  it('reads queries, plans and transaction ends', () => {
    for (const sql of [
      'SELECT * FROM dual',
      "SELECT q'[DELETE]' FROM dual",
      'WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a',
      'EXPLAIN PLAN FOR SELECT 1 FROM dual',
      'COMMIT',
      'ROLLBACK',
      'SAVEPOINT a',
    ]) {
      expect(isReadOnlyStatement(sql, oracle), sql).toBe(true);
    }
  });

  it('counts changes, calls and locks as writes', () => {
    for (const sql of [
      'SELECT * FROM t FOR UPDATE',
      'MERGE INTO t USING s ON (1 = 1) WHEN MATCHED THEN UPDATE SET a = 1',
      'CALL p()',
      'INSERT ALL INTO t VALUES (1) SELECT * FROM dual',
    ]) {
      expect(isReadOnlyStatement(sql, oracle), sql).toBe(false);
    }
  });
});

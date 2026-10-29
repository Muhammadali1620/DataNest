import { describe, expect, it } from 'vitest';
import {
  commitsImplicitly,
  transactionControl,
} from '../../../../src/core/sql/transaction-control';

describe('transactionControl', () => {
  it.each([
    ['BEGIN', 'begin'],
    ['begin;', 'begin'],
    ['BEGIN WORK', 'begin'],
    ['BEGIN TRANSACTION', 'begin'],
    ['BEGIN IMMEDIATE TRANSACTION', 'begin'],
    ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'begin'],
    ['BEGIN READ ONLY', 'begin'],
    ['START TRANSACTION', 'begin'],
    ['START TRANSACTION READ WRITE', 'begin'],
    ['COMMIT', 'commit'],
    ['COMMIT WORK', 'commit'],
    ['END', 'commit'],
    ['END TRANSACTION', 'commit'],
    ["PREPARE TRANSACTION 'x'", 'commit'],
    ['ROLLBACK', 'rollback'],
    ['ABORT', 'rollback'],
    ['ROLLBACK WORK', 'rollback'],
    ['ROLLBACK TO SAVEPOINT a', 'savepoint'],
    ['ROLLBACK TO a', 'savepoint'],
    ['ROLLBACK WORK TO SAVEPOINT a', 'savepoint'],
    ['SAVEPOINT a', 'savepoint'],
    ['RELEASE SAVEPOINT a', 'savepoint'],
    ["COMMIT PREPARED 'x'", 'none'],
    ["ROLLBACK PREPARED 'x'", 'none'],
    ['SELECT 1', 'none'],
    ['START SLAVE', 'none'],
    ['PREPARE stmt FROM @s', 'none'],
    ['', 'none'],
  ])('%s → %s', (sql, expected) => {
    expect(transactionControl(sql, 'postgres')).toBe(expected);
  });

  it('skips comments and does not read words in strings', () => {
    expect(transactionControl('-- start\n/* x */ COMMIT', 'postgres')).toBe('commit');
    expect(transactionControl("SELECT 'COMMIT'", 'postgres')).toBe('none');
    expect(transactionControl('# note\nBEGIN', 'mysql')).toBe('begin');
  });

  it('does not take a BEGIN block of a routine for a transaction', () => {
    expect(transactionControl('BEGIN DECLARE x INT; END', 'mysql')).toBe('none');
  });
});

describe('commitsImplicitly', () => {
  it('names the statements MySQL commits an open transaction before', () => {
    for (const sql of [
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD c int',
      'DROP TABLE t',
      'TRUNCATE t',
      'RENAME TABLE a TO b',
      'GRANT SELECT ON *.* TO u',
      'LOCK TABLES t WRITE',
      'ANALYZE TABLE t',
      'BEGIN',
      'START TRANSACTION',
    ]) {
      expect(commitsImplicitly(sql, 'mysql'), sql).toBe(true);
    }
  });

  it('leaves temporary tables, data changes and reads alone', () => {
    for (const sql of [
      'CREATE TEMPORARY TABLE t (id int)',
      'DROP TEMPORARY TABLE t',
      'INSERT INTO t VALUES (1)',
      'SELECT 1',
      'COMMIT',
      '-- CREATE TABLE x',
    ]) {
      expect(commitsImplicitly(sql, 'mysql'), sql).toBe(false);
    }
  });

  it('is never true for PostgreSQL, SQLite or an unknown driver', () => {
    expect(commitsImplicitly('CREATE TABLE t (id int)', 'postgres')).toBe(false);
    expect(commitsImplicitly('DROP TABLE t', 'sqlite')).toBe(false);
    expect(commitsImplicitly('DROP TABLE t', undefined)).toBe(false);
  });
});

describe('transactionControl: T-SQL (V6.2)', () => {
  it.each([
    ['BEGIN TRAN', 'begin'],
    ['begin transaction t1', 'begin'],
    ['BEGIN DISTRIBUTED TRANSACTION', 'begin'],
    ['BEGIN', 'none'],
    ['BEGIN SELECT 1 END', 'none'],
    ['BEGIN TRY SELECT 1 END TRY', 'none'],
    ['COMMIT', 'commit'],
    ['COMMIT TRAN', 'commit'],
    ['COMMIT TRANSACTION t1', 'commit'],
    ['END', 'none'],
    ['ROLLBACK', 'rollback'],
    ['ROLLBACK TRANSACTION', 'rollback'],
    ['ROLLBACK TRAN sp1', 'savepoint'],
    ['SAVE TRANSACTION sp1', 'savepoint'],
    ['SAVE TRAN sp1', 'savepoint'],
    ['SAVE x', 'none'],
    ['SAVEPOINT a', 'none'],
    ['/* BEGIN TRAN */ SELECT 1', 'none'],
  ] as const)('reads %s as %s', (sql, expected) => {
    expect(transactionControl(sql, 'mssql')).toBe(expected);
  });

  it('never commits implicitly', () => {
    expect(commitsImplicitly('CREATE TABLE t (a INT)', 'mssql')).toBe(false);
    expect(commitsImplicitly('BEGIN TRAN', 'mssql')).toBe(false);
  });
});

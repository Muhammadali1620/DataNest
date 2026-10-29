import { describe, expect, it } from 'vitest';
import { needsBegin } from '../../../src/services/manual-commit';

describe('needsBegin', () => {
  it('opens a transaction before a change on an idle session', () => {
    expect(needsBegin('UPDATE t SET a = 1', 'postgres', 'idle')).toBe(true);
    expect(needsBegin('INSERT INTO t VALUES (1)', 'mysql', 'idle')).toBe(true);
    expect(needsBegin('CREATE TABLE t (id int)', 'postgres', 'idle')).toBe(true);
    expect(needsBegin('DELETE FROM t', 'sqlite', 'idle')).toBe(true);
  });

  it('does not open one for reads, so a SELECT never idles in a transaction', () => {
    expect(needsBegin('SELECT * FROM t', 'postgres', 'idle')).toBe(false);
    expect(needsBegin('SHOW TABLES', 'mysql', 'idle')).toBe(false);
  });

  it('leaves statements that manage the transaction themselves alone', () => {
    for (const sql of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'START TRANSACTION']) {
      expect(needsBegin(sql, 'postgres', 'idle'), sql).toBe(false);
    }
  });

  it('does not wrap MySQL DDL, which commits on its own anyway', () => {
    expect(needsBegin('CREATE TABLE t (id int)', 'mysql', 'idle')).toBe(false);
    expect(needsBegin('CREATE TEMPORARY TABLE t (id int)', 'mysql', 'idle')).toBe(true);
  });

  it('does nothing when a transaction is open, failed, or the driver cannot tell', () => {
    expect(needsBegin('UPDATE t SET a = 1', 'postgres', 'open')).toBe(false);
    expect(needsBegin('UPDATE t SET a = 1', 'postgres', 'failed')).toBe(false);
    expect(needsBegin('UPDATE t SET a = 1', 'postgres', undefined)).toBe(false);
  });

  it('opens no transaction for T-SQL transaction control or blocks (SQL Server)', () => {
    expect(needsBegin('BEGIN TRAN', 'mssql', 'idle')).toBe(false);
    expect(needsBegin('SAVE TRANSACTION s', 'mssql', 'idle')).toBe(false);
    expect(needsBegin('UPDATE t SET a = 1', 'mssql', 'idle')).toBe(true);
    expect(needsBegin('SELECT TOP (5) * FROM t', 'mssql', 'idle')).toBe(false);
  });
});

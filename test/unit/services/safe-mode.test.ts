import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import {
  DEFAULT_SAFE_MODE,
  isSafeMode,
  riskyStatements,
  SAFE_MODES,
} from '../../../src/services/safe-mode';

const script = `SELECT 1;
DELETE FROM users;
UPDATE users SET a = 1 WHERE id = 2;
DROP TABLE old;
TRUNCATE logs;`;

describe('riskyStatements', () => {
  const statements = splitStatements(script, 'mysql');

  it('picks out only the dangerous statements, with what is wrong with each', () => {
    const risky = riskyStatements(statements, 'mysql', 'confirm');
    expect(risky.map((entry) => [entry.statement.text, entry.dangers])).toEqual([
      ['DELETE FROM users', ['delete-without-where']],
      ['DROP TABLE old', ['drop']],
      ['TRUNCATE logs', ['truncate']],
    ]);
  });

  it('keeps where each statement is, so a dialog can point at it', () => {
    const [first] = riskyStatements(statements, 'mysql', 'confirm');
    expect(script.slice(first?.statement.start, first?.statement.end)).toBe('DELETE FROM users');
  });

  it('finds the same in block mode, and nothing when it is off', () => {
    expect(riskyStatements(statements, 'mysql', 'block')).toHaveLength(3);
    expect(riskyStatements(statements, 'mysql', 'off')).toEqual([]);
  });

  it('has nothing to say about a safe script or an empty one', () => {
    expect(
      riskyStatements(splitStatements('SELECT 1; SELECT 2', 'mysql'), 'mysql', 'confirm'),
    ).toEqual([]);
    expect(riskyStatements([], 'mysql', 'confirm')).toEqual([]);
  });

  it('reads the dialect of the connection', () => {
    // On PostgreSQL a dollar-quoted body is text; on MySQL `$$` is not special.
    const pg = splitStatements('SELECT $$DROP TABLE x$$', 'postgres');
    expect(riskyStatements(pg, 'postgres', 'confirm')).toEqual([]);
  });

  it('works for a document that is not bound to a connection', () => {
    expect(riskyStatements(splitStatements('DROP TABLE t'), undefined, 'confirm')).toHaveLength(1);
  });
});

describe('safe mode setting', () => {
  it('knows its three values and defaults to asking', () => {
    expect([...SAFE_MODES]).toEqual(['confirm', 'block', 'off']);
    expect(DEFAULT_SAFE_MODE).toBe('confirm');
    expect(SAFE_MODES.every(isSafeMode)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isSafeMode('CONFIRM')).toBe(false);
    expect(isSafeMode(undefined)).toBe(false);
    expect(isSafeMode(true)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import { changeVerdict, NO_POLICY, policyOf, runVerdict } from '../../../src/services/write-policy';

const config = { id: 'c', name: 'Live', driver: 'postgres' as const, host: 'h' };

describe('policyOf', () => {
  it('guards nothing for a missing or plain connection', () => {
    expect(policyOf(undefined)).toEqual(NO_POLICY);
    expect(policyOf(config)).toEqual({ name: 'Live', production: false, readOnly: false });
  });

  it('reads the flags', () => {
    expect(policyOf({ ...config, production: true, readOnly: true })).toEqual({
      name: 'Live',
      production: true,
      readOnly: true,
    });
  });
});

describe('runVerdict', () => {
  const run = (sql: string) => splitStatements(sql, 'postgres');

  it('lets everything through on a plain connection', () => {
    expect(runVerdict(policyOf(config), run('DELETE FROM t'), 'postgres')).toEqual({
      kind: 'allow',
    });
  });

  it('lets reads through on production and read-only connections', () => {
    const reads = run('SELECT 1; SHOW search_path;');
    expect(runVerdict(policyOf({ ...config, production: true }), reads, 'postgres')).toEqual({
      kind: 'allow',
    });
    expect(runVerdict(policyOf({ ...config, readOnly: true }), reads, 'postgres')).toEqual({
      kind: 'allow',
    });
  });

  it('asks about the changing statements on production', () => {
    const verdict = runVerdict(
      policyOf({ ...config, production: true }),
      run('SELECT 1; UPDATE t SET a = 1 WHERE id = 2; DROP TABLE x;'),
      'postgres',
    );
    expect(verdict.kind).toBe('confirm');
    expect(verdict.kind === 'confirm' && verdict.changes.map((s) => s.text)).toEqual([
      'UPDATE t SET a = 1 WHERE id = 2',
      'DROP TABLE x',
    ]);
  });

  it('refuses changes on a read-only connection, production or not', () => {
    const verdict = runVerdict(
      policyOf({ ...config, production: true, readOnly: true }),
      run('INSERT INTO t VALUES (1)'),
      'postgres',
    );
    expect(verdict).toMatchObject({
      kind: 'refuse',
      changes: [{ text: 'INSERT INTO t VALUES (1)' }],
    });
  });
});

describe('changeVerdict', () => {
  it('allows, asks or refuses a change by the flags', () => {
    expect(changeVerdict(policyOf(config))).toBe('allow');
    expect(changeVerdict(policyOf({ ...config, production: true }))).toBe('confirm');
    expect(changeVerdict(policyOf({ ...config, readOnly: true }))).toBe('refuse');
    expect(changeVerdict(policyOf({ ...config, production: true, readOnly: true }))).toBe('refuse');
  });
});

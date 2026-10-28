import { describe, expect, it } from 'vitest';
import { parseSelectSource, type SelectRefusal } from '../../../../src/core/sql/select-source';
import { syntaxOf } from '../../../../src/core/sql/tokenizer';

const mysql = syntaxOf('mysql');
const pg = syntaxOf('postgres');

function refusal(sql: string, syntax = mysql): SelectRefusal | undefined {
  const parsed = parseSelectSource(sql, syntax);
  return parsed.ok ? undefined : parsed.refusal;
}

function source(sql: string, syntax = mysql) {
  const parsed = parseSelectSource(sql, syntax);
  if (!parsed.ok) {
    throw new Error(`refused: ${parsed.refusal}`);
  }
  return parsed.source;
}

describe('parseSelectSource', () => {
  it('reads a plain select of one table', () => {
    expect(source('SELECT * FROM users')).toEqual({
      tableParts: ['users'],
      items: [{ kind: 'star' }],
    });
  });

  it('keeps the table qualifiers and unquotes names', () => {
    expect(source('select id from `my db`.`we``ird`').tableParts).toEqual(['my db', 'we`ird']);
    expect(source('SELECT id FROM "public"."Users"', pg).tableParts).toEqual(['public', 'Users']);
    expect(source('SELECT id FROM db.sch.t', pg).tableParts).toEqual(['db', 'sch', 't']);
  });

  it('reads aliases of the table with and without AS', () => {
    expect(source('SELECT u.id FROM users u').alias).toBe('u');
    expect(source('SELECT u.id FROM users AS u WHERE u.id = 1').alias).toBe('u');
    expect(source('SELECT id FROM users WHERE id = 1').alias).toBeUndefined();
  });

  it('tells columns, aliases, stars and expressions apart', () => {
    expect(
      source('SELECT id, u.name AS n, email e, u.*, COUNT(*), 1, a + b FROM users u').items,
    ).toEqual([
      { kind: 'column', name: 'id', output: 'id' },
      { kind: 'column', name: 'name', output: 'n' },
      { kind: 'column', name: 'email', output: 'e' },
      { kind: 'star' },
      { kind: 'expression' },
      { kind: 'expression' },
      { kind: 'expression' },
    ]);
  });

  it('does not split a select list on commas inside brackets', () => {
    const items = source('SELECT id, COALESCE(a, b), c FROM t').items;
    expect(items).toHaveLength(3);
    expect(items[1]).toEqual({ kind: 'expression' });
  });

  it('allows a trailing semicolon, comments and a where/order/limit tail', () => {
    expect(
      source('-- note\nSELECT /* x */ id FROM t WHERE a IN (SELECT a FROM o) ORDER BY id LIMIT 5;')
        .tableParts,
    ).toEqual(['t']);
  });

  it('accepts ALL, ONLY and FOR UPDATE', () => {
    expect(source('SELECT ALL id FROM t').items).toHaveLength(1);
    expect(source('SELECT id FROM ONLY t', pg).tableParts).toEqual(['t']);
    expect(source('SELECT id FROM t FOR UPDATE').tableParts).toEqual(['t']);
  });

  it('refuses everything that is not a select', () => {
    for (const sql of [
      'UPDATE t SET a = 1',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'SHOW TABLES',
      '',
      '   ',
    ]) {
      expect(refusal(sql)).toBe('not-select');
    }
  });

  it('refuses a select without a table', () => {
    expect(refusal('SELECT 1')).toBe('no-table');
    expect(refusal('SELECT (SELECT 1 FROM t)')).toBe('no-table');
  });

  it('refuses DISTINCT', () => {
    expect(refusal('SELECT DISTINCT a FROM t')).toBe('distinct');
  });

  it('refuses grouping at the top level only', () => {
    expect(refusal('SELECT a, COUNT(*) FROM t GROUP BY a')).toBe('grouped');
    expect(refusal('SELECT a FROM t GROUP BY a HAVING a > 1')).toBe('grouped');
    expect(refusal('SELECT a FROM t WHERE a IN (SELECT a FROM o GROUP BY a)')).toBeUndefined();
  });

  it('refuses compound queries', () => {
    expect(refusal('SELECT a FROM t UNION SELECT a FROM u')).toBe('compound');
    expect(refusal('SELECT a FROM t WHERE x = 1 EXCEPT SELECT a FROM u', pg)).toBe('compound');
    expect(refusal('SELECT a FROM t INTERSECT SELECT a FROM u', pg)).toBe('compound');
  });

  it('refuses joins and comma lists', () => {
    expect(refusal('SELECT * FROM a JOIN b ON a.id = b.id')).toBe('multiple-tables');
    expect(refusal('SELECT * FROM a LEFT JOIN b ON 1')).toBe('multiple-tables');
    expect(refusal('SELECT * FROM a x CROSS JOIN b')).toBe('multiple-tables');
    expect(refusal('SELECT * FROM a, b')).toBe('multiple-tables');
  });

  it('refuses subqueries in FROM', () => {
    expect(refusal('SELECT * FROM (SELECT 1) x')).toBe('subquery');
  });

  it('refuses table functions and other oddities after the name', () => {
    expect(refusal('SELECT * FROM generate_series(1, 3)', pg)).toBe('complex');
    expect(refusal('SELECT * FROM t TABLESAMPLE SYSTEM (10)', pg)).toBe('complex');
    expect(refusal('SELECT * FROM')).toBe('complex');
    expect(refusal('SELECT * FROM 5')).toBe('complex');
    expect(refusal('SELECT * FROM a.b.c.d')).toBe('complex');
    expect(refusal('SELECT * FROM t AS')).toBe('complex');
  });

  it('refuses several statements', () => {
    expect(refusal('SELECT * FROM t; DELETE FROM t')).toBe('complex');
  });

  it('does not mistake words inside strings and comments for keywords', () => {
    expect(refusal("SELECT 'a UNION b' AS x, id FROM t WHERE n = 'GROUP BY'")).toBeUndefined();
    expect(refusal('SELECT id FROM t -- JOIN x')).toBeUndefined();
  });

  it('never throws on broken input', () => {
    for (const sql of [
      "SELECT 'oops",
      'SELECT ( FROM',
      'SELECT * FROM `t',
      '))))',
      'SELECT * FROM t WHERE (',
    ]) {
      expect(() => parseSelectSource(sql, mysql)).not.toThrow();
    }
  });
});

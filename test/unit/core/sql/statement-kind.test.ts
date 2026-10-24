import { describe, expect, it } from 'vitest';
import {
  changesStructure,
  leadingKeyword,
  stripLeadingNoise,
} from '../../../../src/core/sql/statement-kind';

describe('stripLeadingNoise', () => {
  it('drops whitespace', () => {
    expect(stripLeadingNoise('  \n\t SELECT 1')).toBe('SELECT 1');
  });

  it('drops line comments in all three spellings', () => {
    expect(stripLeadingNoise('-- a comment\nSELECT 1')).toBe('SELECT 1');
    expect(stripLeadingNoise('# mysql comment\nSELECT 1')).toBe('SELECT 1');
    expect(stripLeadingNoise('--one\n--two\n  SELECT 1')).toBe('SELECT 1');
  });

  it('drops block comments, including several in a row', () => {
    expect(stripLeadingNoise('/* hi */ SELECT 1')).toBe('SELECT 1');
    expect(stripLeadingNoise('/* a */ /* b */\nSELECT 1')).toBe('SELECT 1');
    expect(stripLeadingNoise('/* multi\nline */SELECT 1')).toBe('SELECT 1');
  });

  it('returns nothing for a statement that is only comments', () => {
    expect(stripLeadingNoise('-- just a note')).toBe('');
    expect(stripLeadingNoise('/* unterminated')).toBe('');
    expect(stripLeadingNoise('   ')).toBe('');
  });

  it('leaves a comment that is not at the start alone', () => {
    expect(stripLeadingNoise('SELECT 1 -- trailing')).toBe('SELECT 1 -- trailing');
  });
});

describe('leadingKeyword', () => {
  it('uppercases the first word', () => {
    expect(leadingKeyword('select 1')).toBe('SELECT');
    expect(leadingKeyword('  create table t (a int)')).toBe('CREATE');
  });

  it('looks past comments', () => {
    expect(leadingKeyword('-- note\nDROP TABLE t')).toBe('DROP');
    expect(leadingKeyword('/* note */ alter table t')).toBe('ALTER');
  });

  it('is empty for blank input and for a statement starting with punctuation', () => {
    expect(leadingKeyword('')).toBe('');
    expect(leadingKeyword('   ')).toBe('');
    expect(leadingKeyword('(SELECT 1)')).toBe('');
  });
});

describe('changesStructure', () => {
  it('is true for DDL', () => {
    for (const sql of [
      'CREATE TABLE t (a int)',
      'alter table t add b int',
      'DROP VIEW v',
      'TRUNCATE TABLE t',
      'RENAME TABLE a TO b',
      "COMMENT ON TABLE t IS 'x'",
      'GRANT SELECT ON t TO u',
      'REVOKE SELECT ON t FROM u',
      "ATTACH DATABASE 'a.db' AS a",
      'REFRESH MATERIALIZED VIEW mv',
    ]) {
      expect(changesStructure(sql), sql).toBe(true);
    }
  });

  it('is true for calls, which may run anything', () => {
    expect(changesStructure('CALL rebuild()')).toBe(true);
    expect(changesStructure('EXEC sp_do_things')).toBe(true);
  });

  it('is false for plain reads and writes', () => {
    for (const sql of [
      'SELECT 1',
      'select * from t',
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'SHOW TABLES',
      'EXPLAIN SELECT 1',
      'BEGIN',
      'COMMIT',
    ]) {
      expect(changesStructure(sql), sql).toBe(false);
    }
  });

  it('sees through leading comments in both directions', () => {
    expect(changesStructure('-- cleanup\nDROP TABLE t')).toBe(true);
    expect(changesStructure('/* note */ SELECT 1')).toBe(false);
  });

  it('does not count a commented-out verb', () => {
    expect(changesStructure('-- DROP TABLE t\nSELECT 1')).toBe(false);
    expect(changesStructure('/* CREATE TABLE t */ SELECT 1')).toBe(false);
  });

  it('is false for empty input and comments only', () => {
    expect(changesStructure('')).toBe(false);
    expect(changesStructure('   ')).toBe(false);
    expect(changesStructure('-- nothing here')).toBe(false);
  });

  it('does not mistake a word that merely starts with a verb', () => {
    expect(changesStructure('CREATED_AT_SELECT 1')).toBe(false);
    expect(changesStructure('dropped_table_report()')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { KEYWORDS, keywordsOf } from '../../../../src/core/sql/keywords';
import { DRIVER_IDS } from '../../../../src/shared/connection';

describe('KEYWORDS', () => {
  it('has a list for every driver', () => {
    expect(Object.keys(KEYWORDS).sort()).toEqual([...DRIVER_IDS].sort());
  });

  it('is uppercase everywhere, so completion looks consistent', () => {
    for (const driver of DRIVER_IDS) {
      for (const keyword of KEYWORDS[driver]) {
        expect(keyword, keyword).toBe(keyword.toUpperCase());
      }
    }
  });

  it('has no duplicates within a dialect', () => {
    for (const driver of DRIVER_IDS) {
      const list = KEYWORDS[driver];
      expect(new Set(list).size, driver).toBe(list.length);
    }
  });

  it('includes the core SQL every dialect shares', () => {
    for (const driver of DRIVER_IDS) {
      for (const keyword of ['SELECT', 'FROM', 'WHERE', 'JOIN', 'INSERT']) {
        expect(KEYWORDS[driver], `${driver} is missing ${keyword}`).toContain(keyword);
      }
    }
  });

  it('keeps the dialect-only words where they belong', () => {
    expect(KEYWORDS.mysql).toContain('AUTO_INCREMENT');
    expect(KEYWORDS.postgres).not.toContain('AUTO_INCREMENT');
    expect(KEYWORDS.postgres).toContain('ILIKE');
    expect(KEYWORDS.mysql).not.toContain('ILIKE');
    expect(KEYWORDS.sqlite).toContain('PRAGMA');
    expect(KEYWORDS.sqlite).toContain('AUTOINCREMENT');
  });
});

describe('keywordsOf', () => {
  it('returns the list of a driver unchanged', () => {
    expect(keywordsOf('mysql')).toBe(KEYWORDS.mysql);
  });

  it('merges every dialect when the connection is unknown', () => {
    const all = keywordsOf();
    expect(all).toContain('AUTO_INCREMENT');
    expect(all).toContain('ILIKE');
    expect(all).toContain('PRAGMA');
  });

  it('merges without duplicates and in order', () => {
    const all = keywordsOf();
    expect(new Set(all).size).toBe(all.length);
    expect([...all]).toEqual([...all].sort());
  });
});

describe('SQL Server keywords (V6.2)', () => {
  it('offers T-SQL words for SQL Server and in the union', () => {
    for (const word of ['TOP', 'GO', 'IDENTITY', 'NVARCHAR', 'CROSS APPLY', 'BEGIN TRAN']) {
      expect(KEYWORDS.mssql, word).toContain(word);
      expect(keywordsOf(), word).toContain(word);
    }
    expect(KEYWORDS.mssql).not.toContain('LIMIT');
  });
});

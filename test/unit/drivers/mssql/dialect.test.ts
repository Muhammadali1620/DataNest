import { describe, expect, it } from 'vitest';
import { literal, mssqlDialect, paginate } from '../../../../src/drivers/mssql/dialect';

describe('mssql literal', () => {
  it('writes NULL, bits and numbers', () => {
    expect(literal(null)).toBe('NULL');
    expect(literal(true)).toBe('1');
    expect(literal(false)).toBe('0');
    expect(literal(-1.5)).toBe('-1.5');
    expect(literal(0)).toBe('0');
  });

  it('refuses NaN and infinities, which no SQL Server number can hold', () => {
    expect(() => literal(Number.NaN)).toThrow(/cannot store NaN/u);
    expect(() => literal(Number.POSITIVE_INFINITY)).toThrow(/Infinity/u);
  });

  it('writes text as Unicode strings', () => {
    expect(literal("it's")).toBe("N'it''s'");
    expect(literal({ kind: 'json', text: '{"a":1}' })).toBe(`N'{"a":1}'`);
    expect(literal({ kind: 'datetime', text: '2024-01-02 03:04:05.1234567' })).toBe(
      "N'2024-01-02 03:04:05.1234567'",
    );
  });

  it('writes exact numbers bare, and anything odd as a string', () => {
    expect(literal({ kind: 'decimal', text: '-12.50' })).toBe('-12.50');
    expect(literal({ kind: 'bigint', text: '9223372036854775807' })).toBe('9223372036854775807');
    expect(literal({ kind: 'decimal', text: '1e5' })).toBe('1e5');
    expect(literal({ kind: 'decimal', text: '1; DROP TABLE t' })).toBe("N'1; DROP TABLE t'");
  });

  it('writes bytes as a 0x literal', () => {
    expect(literal({ kind: 'binary', size: 2, preview: 'cafe' })).toBe('0xcafe');
    expect(literal({ kind: 'binary', size: 0, preview: '' })).toBe('0x');
  });
});

describe('mssql paginate', () => {
  it('takes TOP for the first page', () => {
    expect(paginate('SELECT * FROM [t]', 100, 0)).toBe('SELECT TOP (100) * FROM [t]');
    expect(paginate('select distinct a from t;', 5, 0)).toBe('select distinct TOP (5) a from t');
    expect(paginate('SELECT ALL a FROM t', 5, 0)).toBe('SELECT ALL TOP (5) a FROM t');
  });

  it('pages a CTE by its outer SELECT', () => {
    expect(paginate('WITH c AS (SELECT a FROM t) SELECT a FROM c', 3, 0)).toBe(
      'WITH c AS (SELECT a FROM t) SELECT TOP (3) a FROM c',
    );
  });

  it('uses OFFSET … FETCH for later pages, asking for the server order when none is given', () => {
    expect(paginate('SELECT * FROM t', 50, 100)).toBe(
      'SELECT * FROM t ORDER BY (SELECT NULL) OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY',
    );
    expect(paginate('SELECT * FROM t ORDER BY [id] DESC', 50, 0)).toBe(
      'SELECT * FROM t ORDER BY [id] DESC OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY',
    );
  });

  it('does not take an ORDER BY inside a subquery for the outer one', () => {
    expect(paginate('SELECT * FROM (SELECT TOP 5 a FROM t ORDER BY a) x', 2, 0)).toBe(
      'SELECT TOP (2) * FROM (SELECT TOP 5 a FROM t ORDER BY a) x',
    );
  });

  it('wraps a query that already has TOP, or is no SELECT', () => {
    expect(paginate('SELECT TOP (10) a FROM t', 5, 0)).toBe(
      'SELECT * FROM (SELECT TOP (10) a FROM t) AS [page] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY',
    );
    expect(paginate('EXEC p', 5, 10)).toMatch(/^SELECT \* FROM \(EXEC p\) AS \[page\]/u);
  });

  it('is not fooled by keywords inside strings and brackets', () => {
    expect(paginate("SELECT 'ORDER BY' AS [order by] FROM t", 1, 0)).toBe(
      "SELECT TOP (1) 'ORDER BY' AS [order by] FROM t",
    );
  });

  it('refuses a page that makes no sense', () => {
    expect(() => paginate('SELECT 1', -1, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('SELECT 1', 1, 0.5)).toThrow(/Invalid page/u);
  });
});

describe('mssqlDialect', () => {
  it('quotes with brackets and keeps T-SQL keywords', () => {
    expect(mssqlDialect.quoteIdentifier('a]')).toBe('[a]]]');
    expect(mssqlDialect.quoteTable({ schema: 's', name: 't' })).toBe('[s].[t]');
    expect(mssqlDialect.keywords).toEqual(expect.arrayContaining(['TOP', 'MERGE', 'GO']));
  });

  it('estimates rows from the storage of the heap or clustered index', () => {
    expect(mssqlDialect.estimateRowsSql?.({ schema: 'dbo', name: "o'rders" })).toBe(
      "SELECT SUM(rows) FROM sys.partitions WHERE object_id = OBJECT_ID(N'[dbo].[o''rders]') AND index_id IN (0, 1)",
    );
  });

  it('matches text without regard to case or the column type', () => {
    expect(mssqlDialect.likeText('[c]', "N'%a!%%'")).toBe(
      "CAST([c] AS NVARCHAR(MAX)) COLLATE Latin1_General_100_CI_AS LIKE N'%a!%%' ESCAPE '!'",
    );
  });

  it('inserts a row of defaults and knows the DEFAULT keyword', () => {
    expect(mssqlDialect.insertDefaultRow('[t]')).toBe('INSERT INTO [t] DEFAULT VALUES');
    expect(mssqlDialect.defaultKeyword).toBe(true);
    expect(mssqlDialect.setTimeZone).toBeUndefined();
  });

  it('spells transactions and savepoints the T-SQL way, with no RELEASE', () => {
    const words = mssqlDialect.transaction;
    expect([words.begin, words.commit, words.rollback]).toEqual([
      'BEGIN TRANSACTION',
      'COMMIT TRANSACTION',
      'ROLLBACK TRANSACTION',
    ]);
    expect(words.savepoint('s')).toBe('SAVE TRANSACTION s');
    expect(words.rollbackToSavepoint('s')).toBe('ROLLBACK TRANSACTION s');
    expect(words.releaseSavepoint).toBeUndefined();
  });
});

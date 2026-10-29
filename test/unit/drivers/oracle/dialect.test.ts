import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { KEYWORDS } from '../../../../src/core/sql/keywords';
import { oracleDdl } from '../../../../src/drivers/oracle/ddl';
import { TEXT_PIECE } from '../../../../src/drivers/oracle/quote';
import {
  binaryLiteral,
  datetimeLiteral,
  MAX_BINARY_LITERAL,
  literal,
  oracleDialect,
  paginate,
  quoteIdentifier,
  quoteTable,
} from '../../../../src/drivers/oracle/dialect';
import { oracleDump } from '../../../../src/drivers/oracle/dump';

describe('oracle literal', () => {
  it('writes NULL, booleans as 1 and 0, and numbers', () => {
    expect(literal(null)).toBe('NULL');
    expect(literal(true)).toBe('1');
    expect(literal(false)).toBe('0');
    expect(literal(0)).toBe('0');
    expect(literal(-1.5)).toBe('-1.5');
    expect(literal(1e21)).toBe('1e+21');
  });

  it('writes NaN and infinities as BINARY_DOUBLE constants', () => {
    expect(literal(Number.NaN)).toBe('BINARY_DOUBLE_NAN');
    expect(literal(Number.POSITIVE_INFINITY)).toBe('BINARY_DOUBLE_INFINITY');
    expect(literal(Number.NEGATIVE_INFINITY)).toBe('-BINARY_DOUBLE_INFINITY');
  });

  it('writes text as a string, N… only outside ASCII', () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(literal('')).toBe("''");
    expect(literal('Привет')).toBe("N'Привет'");
  });

  it('writes exact numbers bare and anything odd as a string', () => {
    expect(literal({ kind: 'decimal', text: '-12.50' })).toBe('-12.50');
    expect(literal({ kind: 'decimal', text: '1e5' })).toBe('1e5');
    expect(literal({ kind: 'decimal', text: '2.5E-10' })).toBe('2.5E-10');
    expect(literal({ kind: 'bigint', text: '-99999999999999999999999' })).toBe(
      '-99999999999999999999999',
    );
    expect(literal({ kind: 'decimal', text: '1; DROP TABLE t' })).toBe("'1; DROP TABLE t'");
    expect(literal({ kind: 'decimal', text: '.5' })).toBe("'.5'");
    expect(literal({ kind: 'bigint', text: '' })).toBe("''");
  });

  it('writes JSON as a string', () => {
    expect(literal({ kind: 'json', text: '{"a":"it\'s"}' })).toBe(`'{"a":"it''s"}'`);
  });

  it('writes long text and JSON as joined CLOB pieces', () => {
    const text = 'x'.repeat(TEXT_PIECE + 1);
    expect(literal(text)).toBe(`TO_CLOB('${'x'.repeat(TEXT_PIECE)}') || TO_CLOB('x')`);
    expect(literal({ kind: 'json', text })).toBe(
      `TO_CLOB('${'x'.repeat(TEXT_PIECE)}') || TO_CLOB('x')`,
    );
    expect(literal('x'.repeat(TEXT_PIECE))).toBe(`'${'x'.repeat(TEXT_PIECE)}'`);
  });

  it('writes bytes with HEXTORAW', () => {
    expect(literal({ kind: 'binary', size: 2, preview: 'cafe' })).toBe("HEXTORAW('cafe')");
    expect(literal({ kind: 'binary', size: 0, preview: '' })).toBe("HEXTORAW('')");
  });

  it('refuses bytes too long for one SQL literal rather than cutting them', () => {
    const preview = 'ab'.repeat(MAX_BINARY_LITERAL + 1);
    expect(() => literal({ kind: 'binary', size: MAX_BINARY_LITERAL + 1, preview })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('writes datetimes as typed literals', () => {
    expect(literal({ kind: 'datetime', text: '2024-02-29' })).toBe("DATE '2024-02-29'");
    expect(literal({ kind: 'datetime', text: '2024-02-29 10:00:00.5' })).toBe(
      "TIMESTAMP '2024-02-29 10:00:00.5'",
    );
  });
});

describe('binaryLiteral', () => {
  it('writes HEXTORAW up to 2000 bytes', () => {
    expect(MAX_BINARY_LITERAL).toBe(2000);
    expect(binaryLiteral('00ff')).toBe("HEXTORAW('00ff')");
    const longest = 'ab'.repeat(MAX_BINARY_LITERAL);
    expect(binaryLiteral(longest)).toBe(`HEXTORAW('${longest}')`);
  });

  it('refuses more than 2000 bytes, saying how many there are', () => {
    expect(() => binaryLiteral('ab'.repeat(MAX_BINARY_LITERAL + 1))).toThrow(DbError);
    expect(() => binaryLiteral('ab'.repeat(MAX_BINARY_LITERAL + 1))).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: expect.stringContaining('2001') as unknown,
      }),
    );
  });
});

describe('datetimeLiteral', () => {
  it('writes a day as DATE', () => {
    expect(datetimeLiteral('2024-02-29')).toBe("DATE '2024-02-29'");
    expect(datetimeLiteral('  2024-02-29  ')).toBe("DATE '2024-02-29'");
  });

  it('writes a moment as TIMESTAMP, with a space for the T', () => {
    expect(datetimeLiteral('2024-02-29 10:11:12')).toBe("TIMESTAMP '2024-02-29 10:11:12'");
    expect(datetimeLiteral('2024-02-29T10:11:12.123456789')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12.123456789'",
    );
  });

  it('adds the seconds to a moment written to the minute', () => {
    expect(datetimeLiteral('2024-02-29 10:11')).toBe("TIMESTAMP '2024-02-29 10:11:00'");
    expect(datetimeLiteral('2024-02-29T10:11')).toBe("TIMESTAMP '2024-02-29 10:11:00'");
  });

  it('writes Z and UTC as +00:00', () => {
    expect(datetimeLiteral('2024-02-29T10:11:12Z')).toBe("TIMESTAMP '2024-02-29 10:11:12 +00:00'");
    expect(datetimeLiteral('2024-02-29T10:11:12 UTC')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12 +00:00'",
    );
    expect(datetimeLiteral('2024-02-29T10:11:12.5UTC')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12.5 +00:00'",
    );
    expect(datetimeLiteral('2024-02-29 10:11:12.5 Z')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12.5 +00:00'",
    );
  });

  it('reads UTC and Z after a space too, and adds seconds to a zoned minute', () => {
    expect(datetimeLiteral('2024-02-29 10:11:12 UTC')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12 +00:00'",
    );
    expect(datetimeLiteral('2024-02-29 10:11:12.5UTC')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12.5 +00:00'",
    );
    expect(datetimeLiteral('2024-02-29T10:11Z')).toBe("TIMESTAMP '2024-02-29 10:11:00 +00:00'");
    expect(datetimeLiteral('2024-02-29 10:11+03:00')).toBe(
      "TIMESTAMP '2024-02-29 10:11:00 +03:00'",
    );
  });

  it('puts a space before an offset written right after the time', () => {
    expect(datetimeLiteral('2024-02-29 10:11:12+03:00')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12 +03:00'",
    );
    expect(datetimeLiteral('2024-02-29 10:11:12.250-05:30')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12.250 -05:30'",
    );
    // Oracle reads only ±HH:MM (ORA-01874 for +0300, ORA-01861 for +03).
    expect(datetimeLiteral('2024-02-29 10:11:12+0300')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12 +03:00'",
    );
    expect(datetimeLiteral('2024-02-29 10:11:12 -03')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12 -03:00'",
    );
    expect(datetimeLiteral('2024-02-29 10:11:12 +03:00')).toBe(
      "TIMESTAMP '2024-02-29 10:11:12 +03:00'",
    );
  });

  it('leaves other text a string the server converts', () => {
    expect(datetimeLiteral('10:11:12')).toBe("'10:11:12'");
    expect(datetimeLiteral('+01 02:03:04.000000')).toBe("'+01 02:03:04.000000'");
    expect(datetimeLiteral('29.02.2024')).toBe("'29.02.2024'");
    expect(datetimeLiteral('2024-02-29 10:11:12 Europe/Berlin')).toBe(
      "'2024-02-29 10:11:12 Europe/Berlin'",
    );
    expect(datetimeLiteral("Tuesday's")).toBe("'Tuesday''s'");
    expect(datetimeLiteral('')).toBe("''");
  });
});

describe('oracle paginate', () => {
  it('takes FETCH FIRST for the first page', () => {
    expect(paginate('SELECT * FROM "T"', 100, 0)).toBe(
      'SELECT * FROM "T" FETCH FIRST 100 ROWS ONLY',
    );
    expect(paginate('SELECT 1 FROM dual', 0, 0)).toBe('SELECT 1 FROM dual FETCH FIRST 0 ROWS ONLY');
  });

  it('takes OFFSET … FETCH NEXT for later pages', () => {
    expect(paginate('SELECT * FROM "T" ORDER BY "ID"', 50, 100)).toBe(
      'SELECT * FROM "T" ORDER BY "ID" OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY',
    );
  });

  it('strips trailing semicolons and blanks first', () => {
    expect(paginate('SELECT * FROM t ;\n ;; ', 5, 0)).toBe(
      'SELECT * FROM t FETCH FIRST 5 ROWS ONLY',
    );
    expect(paginate('SELECT * FROM t;', 5, 10)).toBe(
      'SELECT * FROM t OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
    );
  });

  it('refuses limits and offsets that are negative or not whole', () => {
    expect(() => paginate('SELECT 1 FROM dual', -1, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('SELECT 1 FROM dual', 1.5, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('SELECT 1 FROM dual', Number.NaN, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('SELECT 1 FROM dual', 10, -1)).toThrow(/Invalid page/u);
    expect(() => paginate('SELECT 1 FROM dual', 10, 0.5)).toThrow(/Invalid page/u);
    expect(() => paginate('SELECT 1 FROM dual', Number.POSITIVE_INFINITY, 0)).toThrow(
      /Invalid page/u,
    );
  });
});

describe('oracleDialect', () => {
  it('wires the Oracle keywords, quoting, DDL and dump', () => {
    expect(oracleDialect.keywords).toBe(KEYWORDS.oracle);
    expect(oracleDialect).toHaveProperty('quoteIdentifier', quoteIdentifier);
    expect(oracleDialect).toHaveProperty('quoteTable', quoteTable);
    expect(oracleDialect).toHaveProperty('literal', literal);
    expect(oracleDialect).toHaveProperty('paginate', paginate);
    expect(oracleDialect.literal({ kind: 'datetime', text: '2024-01-02' })).toBe(
      "DATE '2024-01-02'",
    );
    expect(oracleDialect.paginate('SELECT 1 FROM dual', 1, 2)).toBe(
      paginate('SELECT 1 FROM dual', 1, 2),
    );
    expect(oracleDialect.ddl).toBe(oracleDdl);
    expect(oracleDialect.dump).toBe(oracleDump);
    expect(oracleDialect.defaultKeyword).toBe(true);
  });

  it('estimates rows from the statistics of the named or current schema', () => {
    expect(oracleDialect.estimateRowsSql?.({ schema: "O'X", name: 'ORDERS' })).toBe(
      "SELECT num_rows FROM all_tables WHERE owner = 'O''X' AND table_name = 'ORDERS'",
    );
    expect(oracleDialect.estimateRowsSql?.({ name: 'Заказы' })).toBe(
      "SELECT num_rows FROM all_tables WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AND table_name = N'Заказы'",
    );
  });

  it('sets the session time zone with a quoted name', () => {
    expect(oracleDialect.setTimeZone?.('+03:00')).toBe("ALTER SESSION SET TIME_ZONE = '+03:00'");
    expect(oracleDialect.setTimeZone?.("Europe/x'y")).toBe(
      "ALTER SESSION SET TIME_ZONE = 'Europe/x''y'",
    );
  });

  it('searches text without case, escaping with !, and without TO_CHAR that breaks on CLOBs', () => {
    expect(oracleDialect.likeText('"NAME"', "'%ab!%%'")).toBe(
      "UPPER(\"NAME\") LIKE UPPER('%ab!%%') ESCAPE '!'",
    );
  });

  it('refuses a row of defaults only', () => {
    expect(() => oracleDialect.insertDefaultRow('"T"')).toThrow(DbError);
    expect(() => oracleDialect.insertDefaultRow('"T"')).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('spells transactions and savepoints the Oracle way', () => {
    const { transaction } = oracleDialect;
    expect(transaction.begin).toBe('SET TRANSACTION READ WRITE');
    expect(transaction.commit).toBe('COMMIT');
    expect(transaction.rollback).toBe('ROLLBACK');
    expect(transaction.savepoint('dn_1')).toBe('SAVEPOINT dn_1');
    expect(transaction.rollbackToSavepoint('dn_1')).toBe('ROLLBACK TO SAVEPOINT dn_1');
  });
});

import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';

describe('mysqlDialect.quoteIdentifier', () => {
  it('wraps names in backticks', () => {
    expect(mysqlDialect.quoteIdentifier('users')).toBe('`users`');
  });

  it('escapes backticks by doubling', () => {
    expect(mysqlDialect.quoteIdentifier('we`ird')).toBe('`we``ird`');
  });

  it('keeps unicode and spaces intact', () => {
    expect(mysqlDialect.quoteIdentifier('таблица с пробелом')).toBe('`таблица с пробелом`');
  });

  it('rejects empty names and NUL bytes', () => {
    expect(() => mysqlDialect.quoteIdentifier('')).toThrow('empty');
    expect(() => mysqlDialect.quoteIdentifier('a\u0000b')).toThrow('NUL');
  });
});

describe('mysqlDialect.quoteTable', () => {
  it('qualifies with the database when present', () => {
    expect(mysqlDialect.quoteTable({ database: 'shop', name: 'orders' })).toBe('`shop`.`orders`');
    expect(mysqlDialect.quoteTable({ name: 'orders' })).toBe('`orders`');
  });
});

describe('mysqlDialect.literal', () => {
  it('renders primitives', () => {
    expect(mysqlDialect.literal(null)).toBe('NULL');
    expect(mysqlDialect.literal(true)).toBe('TRUE');
    expect(mysqlDialect.literal(false)).toBe('FALSE');
    expect(mysqlDialect.literal(42.5)).toBe('42.5');
  });

  it('turns non-finite numbers into NULL', () => {
    expect(mysqlDialect.literal(Number.NaN)).toBe('NULL');
    expect(mysqlDialect.literal(Number.POSITIVE_INFINITY)).toBe('NULL');
  });

  it('escapes quotes and backslashes in strings', () => {
    expect(mysqlDialect.literal("O'Brien")).toBe("'O''Brien'");
    expect(mysqlDialect.literal('back\\slash')).toBe("'back\\\\slash'");
  });

  it('keeps numeric bigint/decimal text unquoted and quotes the rest', () => {
    expect(mysqlDialect.literal({ kind: 'bigint', text: '9223372036854775807' })).toBe(
      '9223372036854775807',
    );
    expect(mysqlDialect.literal({ kind: 'decimal', text: '-1.50' })).toBe('-1.50');
    expect(mysqlDialect.literal({ kind: 'decimal', text: 'DROP TABLE x' })).toBe("'DROP TABLE x'");
  });

  it('quotes datetime and json, renders binary previews as hex', () => {
    expect(mysqlDialect.literal({ kind: 'datetime', text: '2024-01-01 00:00:00' })).toBe(
      "'2024-01-01 00:00:00'",
    );
    expect(mysqlDialect.literal({ kind: 'json', text: '{"a":1}' })).toBe('\'{"a":1}\'');
    expect(mysqlDialect.literal({ kind: 'binary', size: 4, preview: 'deadbeef' })).toBe(
      "x'deadbeef'",
    );
  });
});

describe('mysqlDialect.paginate', () => {
  it('appends LIMIT and OFFSET, dropping a trailing semicolon', () => {
    expect(mysqlDialect.paginate('SELECT * FROM t;', 100, 0)).toBe('SELECT * FROM t LIMIT 100');
    expect(mysqlDialect.paginate('SELECT * FROM t', 50, 200)).toBe(
      'SELECT * FROM t LIMIT 50 OFFSET 200',
    );
  });

  it('rejects negative or fractional pages', () => {
    expect(() => mysqlDialect.paginate('SELECT 1', -1, 0)).toThrow('Invalid page');
    expect(() => mysqlDialect.paginate('SELECT 1', 10, 0.5)).toThrow('Invalid page');
  });
});

describe('mysqlDialect.keywords', () => {
  it('contains the core keywords in uppercase', () => {
    expect(mysqlDialect.keywords).toContain('SELECT');
    expect(mysqlDialect.keywords).toContain('AUTO_INCREMENT');
    expect(mysqlDialect.keywords.every((k) => k === k.toUpperCase())).toBe(true);
  });
});

describe('mysqlDialect default handling', () => {
  it('says whether SET column = DEFAULT is available', () => {
    expect(mysqlDialect.defaultKeyword).toBe(true);
  });

  it('inserts a row of defaults', () => {
    expect(mysqlDialect.insertDefaultRow('`t`')).toBe('INSERT INTO `t` () VALUES ()');
  });
});

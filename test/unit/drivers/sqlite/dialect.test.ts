import { describe, expect, it } from 'vitest';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';

describe('sqliteDialect.quoteIdentifier', () => {
  it('wraps names in double quotes and escapes quotes by doubling', () => {
    expect(sqliteDialect.quoteIdentifier('users')).toBe('"users"');
    expect(sqliteDialect.quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it('rejects empty names and NUL bytes', () => {
    expect(() => sqliteDialect.quoteIdentifier('')).toThrow('empty');
    expect(() => sqliteDialect.quoteIdentifier('a\u0000b')).toThrow('NUL');
  });
});

describe('sqliteDialect.quoteTable', () => {
  it('prefixes attached database names and leaves main tables bare', () => {
    expect(sqliteDialect.quoteTable({ name: 'orders' })).toBe('"orders"');
    expect(sqliteDialect.quoteTable({ database: 'aux', name: 'orders' })).toBe('"aux"."orders"');
  });
});

describe('sqliteDialect.literal', () => {
  it('renders primitives; booleans become integers', () => {
    expect(sqliteDialect.literal(null)).toBe('NULL');
    expect(sqliteDialect.literal(true)).toBe('1');
    expect(sqliteDialect.literal(false)).toBe('0');
    expect(sqliteDialect.literal("O'Brien")).toBe("'O''Brien'");
    expect(sqliteDialect.literal('back\\slash')).toBe("'back\\slash'");
    expect(sqliteDialect.literal(Number.NaN)).toBe('NULL');
  });

  it('keeps numeric text unquoted and renders blob previews as hex', () => {
    expect(sqliteDialect.literal({ kind: 'bigint', text: '9007199254740993' })).toBe(
      '9007199254740993',
    );
    expect(sqliteDialect.literal({ kind: 'decimal', text: 'evil' })).toBe("'evil'");
    expect(sqliteDialect.literal({ kind: 'binary', size: 4, preview: 'deadbeef' })).toBe(
      "x'deadbeef'",
    );
  });
});

describe('sqliteDialect.paginate', () => {
  it('appends LIMIT/OFFSET and validates the page', () => {
    expect(sqliteDialect.paginate('SELECT * FROM t;', 100, 0)).toBe('SELECT * FROM t LIMIT 100');
    expect(sqliteDialect.paginate('SELECT * FROM t', 50, 200)).toBe(
      'SELECT * FROM t LIMIT 50 OFFSET 200',
    );
    expect(() => sqliteDialect.paginate('SELECT 1', 10, -1)).toThrow('Invalid page');
  });
});

describe('sqliteDialect.keywords', () => {
  it('contains SQLite-specific keywords in uppercase', () => {
    expect(sqliteDialect.keywords).toContain('PRAGMA');
    expect(sqliteDialect.keywords).toContain('AUTOINCREMENT');
    expect(sqliteDialect.keywords.every((k) => k === k.toUpperCase())).toBe(true);
  });
});

describe('sqliteDialect default handling', () => {
  it('says whether SET column = DEFAULT is available', () => {
    expect(sqliteDialect.defaultKeyword).toBe(false);
  });

  it('inserts a row of defaults', () => {
    expect(sqliteDialect.insertDefaultRow('"t"')).toBe('INSERT INTO "t" DEFAULT VALUES');
  });
});

describe('sqliteDialect.likeText', () => {
  it('casts the column to text and escapes with !', () => {
    const q = sqliteDialect.quoteIdentifier('c');
    expect(sqliteDialect.likeText(q, "'%x%'")).toBe(`CAST(${q} AS TEXT) LIKE '%x%' ESCAPE '!'`);
  });
});

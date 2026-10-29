import { describe, expect, it } from 'vitest';
import { quoteIdentifier, quoteString, quoteTable } from '../../../../src/drivers/clickhouse/quote';

describe('clickhouse quoting', () => {
  it('puts identifiers in backticks with backslash escapes', () => {
    expect(quoteIdentifier('orders')).toBe('`orders`');
    expect(quoteIdentifier('a`b')).toBe('`a\\`b`');
    expect(quoteIdentifier('a\\b')).toBe('`a\\\\b`');
    expect(quoteIdentifier('.inner_id.x')).toBe('`.inner_id.x`');
  });

  it('refuses an empty name and one with NUL', () => {
    expect(() => quoteIdentifier('')).toThrow(/empty/u);
    expect(() => quoteIdentifier('a\u0000b')).toThrow(/NUL/u);
  });

  it('qualifies a table by its database, and ignores a schema', () => {
    expect(quoteTable({ database: 'shop', name: 'orders' })).toBe('`shop`.`orders`');
    expect(quoteTable({ name: 'orders' })).toBe('`orders`');
    expect(quoteTable({ schema: 'x', name: 'o' })).toBe('`o`');
  });

  it('writes strings with backslash escapes, the backslash first', () => {
    expect(quoteString("O'Brien")).toBe("'O\\'Brien'");
    expect(quoteString('a\\b')).toBe("'a\\\\b'");
    expect(quoteString("\\'")).toBe("'\\\\\\''");
    expect(quoteString('')).toBe("''");
    expect(quoteString('日本語\n')).toBe("'日本語\n'");
  });
});

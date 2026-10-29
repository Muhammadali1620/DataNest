import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTIFIER_LENGTH,
  quoteIdentifier,
  quoteString,
  quoteTable,
} from '../../../../src/drivers/mssql/quote';

describe('mssql quoting', () => {
  it('puts identifiers in brackets and doubles a closing bracket', () => {
    expect(quoteIdentifier('orders')).toBe('[orders]');
    expect(quoteIdentifier('a]b')).toBe('[a]]b]');
    expect(quoteIdentifier('[x')).toBe('[[x]');
    expect(quoteIdentifier('with space')).toBe('[with space]');
  });

  it('refuses an empty name and one with NUL', () => {
    expect(() => quoteIdentifier('')).toThrow(/empty/u);
    expect(() => quoteIdentifier('a\u0000b')).toThrow(/NUL/u);
  });

  it('qualifies a table by its schema only, never its database', () => {
    expect(quoteTable({ schema: 'sales', name: 'orders' })).toBe('[sales].[orders]');
    expect(quoteTable({ name: 'orders' })).toBe('[orders]');
    expect(quoteTable({ database: 'shop', schema: 'dbo', name: 'o' })).toBe('[dbo].[o]');
  });

  it('writes strings as Unicode literals', () => {
    expect(quoteString("O'Brien")).toBe("N'O''Brien'");
    expect(quoteString('')).toBe("N''");
    expect(quoteString('日本語')).toBe("N'日本語'");
  });

  it('knows the length of sysname', () => {
    expect(MAX_IDENTIFIER_LENGTH).toBe(128);
  });
});

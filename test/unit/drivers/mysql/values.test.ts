import { describe, expect, it } from 'vitest';
import {
  BINARY_PREVIEW_BYTES,
  MYSQL_TYPE,
  mysqlTypeName,
  toCellValue,
} from '../../../../src/drivers/mysql/values';

describe('toCellValue (mysql)', () => {
  it('passes null and undefined through as null', () => {
    expect(toCellValue(null)).toBeNull();
    expect(toCellValue(undefined)).toBeNull();
  });

  it('keeps plain strings, numbers and booleans', () => {
    expect(toCellValue('text', MYSQL_TYPE.VAR_STRING)).toBe('text');
    expect(toCellValue(42, MYSQL_TYPE.LONG)).toBe(42);
    expect(toCellValue(1.5, MYSQL_TYPE.DOUBLE)).toBe(1.5);
    expect(toCellValue(true)).toBe(true);
  });

  it('tags bigint and decimal strings by column type', () => {
    expect(toCellValue('9223372036854775807', MYSQL_TYPE.LONGLONG)).toEqual({
      kind: 'bigint',
      text: '9223372036854775807',
    });
    expect(toCellValue('-9223372036854775808', MYSQL_TYPE.LONGLONG)).toEqual({
      kind: 'bigint',
      text: '-9223372036854775808',
    });
    expect(toCellValue('12345678901234567890.0123456789', MYSQL_TYPE.NEWDECIMAL)).toEqual({
      kind: 'decimal',
      text: '12345678901234567890.0123456789',
    });
  });

  it('tags date/time strings without touching the text', () => {
    expect(toCellValue('2024-12-31 23:59:59.123456', MYSQL_TYPE.DATETIME)).toEqual({
      kind: 'datetime',
      text: '2024-12-31 23:59:59.123456',
    });
    expect(toCellValue('23:59:59', MYSQL_TYPE.TIME)).toEqual({
      kind: 'datetime',
      text: '23:59:59',
    });
  });

  it('tags json strings and stringifies parsed objects', () => {
    expect(toCellValue('{"a":1}', MYSQL_TYPE.JSON)).toEqual({ kind: 'json', text: '{"a":1}' });
    expect(toCellValue({ a: 1 })).toEqual({ kind: 'json', text: '{"a":1}' });
  });

  it('converts buffers to a sized hex preview', () => {
    const value = toCellValue(Buffer.from([0xde, 0xad, 0xbe, 0xef]), MYSQL_TYPE.BLOB);
    expect(value).toEqual({ kind: 'binary', size: 4, preview: 'deadbeef' });
  });

  it('cuts the preview of large buffers but keeps the real size', () => {
    const big = Buffer.alloc(100_000, 0xab);
    const value = toCellValue(big);
    if (typeof value !== 'object' || value?.kind !== 'binary') {
      throw new Error('expected a binary value');
    }
    expect(value.size).toBe(100_000);
    expect(value.preview).toHaveLength(BINARY_PREVIEW_BYTES * 2);
  });

  it('keeps safe integers from bigint columns as numbers', () => {
    expect(toCellValue('42', MYSQL_TYPE.LONGLONG)).toBe(42);
    expect(toCellValue('-7', MYSQL_TYPE.LONGLONG)).toBe(-7);
    expect(toCellValue(String(Number.MAX_SAFE_INTEGER), MYSQL_TYPE.LONGLONG)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(toCellValue(String(Number.MAX_SAFE_INTEGER + 2), MYSQL_TYPE.LONGLONG)).toEqual({
      kind: 'bigint',
      text: String(Number.MAX_SAFE_INTEGER + 2),
    });
  });

  it('converts JS bigint and Date defensively', () => {
    expect(toCellValue(123n)).toBe(123);
    expect(toCellValue(123456789012345678901234567890n)).toEqual({
      kind: 'bigint',
      text: '123456789012345678901234567890',
    });
    const value = toCellValue(new Date(2024, 0, 2, 3, 4, 5));
    expect(value).toEqual({ kind: 'datetime', text: '2024-01-02 03:04:05' });
  });
});

describe('mysqlTypeName', () => {
  it('names known types and returns undefined otherwise', () => {
    expect(mysqlTypeName(MYSQL_TYPE.LONGLONG)).toBe('bigint');
    expect(mysqlTypeName(MYSQL_TYPE.VAR_STRING)).toBe('varchar');
    expect(mysqlTypeName(undefined)).toBeUndefined();
    expect(mysqlTypeName(9999)).toBeUndefined();
  });
});

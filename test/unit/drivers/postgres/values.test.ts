import { describe, expect, it } from 'vitest';
import {
  PG_OID,
  pgTypeName,
  pgTypeParser,
  toCellValue,
} from '../../../../src/drivers/postgres/values';

describe('pgTypeParser', () => {
  it('parses booleans, small integers and floats to JS values', () => {
    expect(pgTypeParser(PG_OID.BOOL)('t')).toBe(true);
    expect(pgTypeParser(PG_OID.BOOL)('f')).toBe(false);
    expect(pgTypeParser(PG_OID.INT4)('42')).toBe(42);
    expect(pgTypeParser(PG_OID.FLOAT8)('3.14')).toBe(3.14);
  });

  it('leaves every other type as text', () => {
    expect(pgTypeParser(PG_OID.INT8)('9223372036854775807')).toBe('9223372036854775807');
    expect(pgTypeParser(PG_OID.NUMERIC)('1.50')).toBe('1.50');
    expect(pgTypeParser(PG_OID.TIMESTAMP)('2024-01-01 00:00:00')).toBe('2024-01-01 00:00:00');
    expect(pgTypeParser(999_999)('anything')).toBe('anything');
  });
});

describe('toCellValue (postgres)', () => {
  it('passes null through and keeps primitives', () => {
    expect(toCellValue(null)).toBeNull();
    expect(toCellValue(undefined)).toBeNull();
    expect(toCellValue(42, PG_OID.INT4)).toBe(42);
    expect(toCellValue(true, PG_OID.BOOL)).toBe(true);
    expect(toCellValue('text', PG_OID.TEXT)).toBe('text');
  });

  it('keeps safe int8 as numbers and tags the rest', () => {
    expect(toCellValue('42', PG_OID.INT8)).toBe(42);
    expect(toCellValue('9223372036854775807', PG_OID.INT8)).toEqual({
      kind: 'bigint',
      text: '9223372036854775807',
    });
  });

  it('tags numeric, datetime and json text', () => {
    expect(toCellValue('12345678901234567890.0123456789', PG_OID.NUMERIC)).toEqual({
      kind: 'decimal',
      text: '12345678901234567890.0123456789',
    });
    expect(toCellValue('2024-12-31 23:59:59.123456', PG_OID.TIMESTAMP)).toEqual({
      kind: 'datetime',
      text: '2024-12-31 23:59:59.123456',
    });
    expect(toCellValue('2024-06-15 12:00:00+00', PG_OID.TIMESTAMPTZ)).toEqual({
      kind: 'datetime',
      text: '2024-06-15 12:00:00+00',
    });
    expect(toCellValue('{"a": 1}', PG_OID.JSONB)).toEqual({ kind: 'json', text: '{"a": 1}' });
  });

  it('decodes bytea hex format into a binary preview', () => {
    expect(toCellValue('\\xdeadbeef', PG_OID.BYTEA)).toEqual({
      kind: 'binary',
      size: 4,
      preview: 'deadbeef',
    });
  });

  it('keeps arrays, intervals and uuids as plain text', () => {
    expect(toCellValue('{1,2,3}', 1007)).toBe('{1,2,3}');
    expect(toCellValue('1 year 2 mons', PG_OID.INTERVAL)).toBe('1 year 2 mons');
    expect(toCellValue('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', PG_OID.UUID)).toBe(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    );
  });

  it('converts buffers and stray objects defensively', () => {
    expect(toCellValue(Buffer.from([1, 2]))).toMatchObject({ kind: 'binary', size: 2 });
    expect(toCellValue({ a: 1 })).toEqual({ kind: 'json', text: '{"a":1}' });
    expect(toCellValue(10n)).toBe(10);
  });
});

describe('pgTypeName', () => {
  it('names known OIDs and returns undefined otherwise', () => {
    expect(pgTypeName(PG_OID.VARCHAR)).toBe('varchar');
    expect(pgTypeName(PG_OID.JSONB)).toBe('jsonb');
    expect(pgTypeName(undefined)).toBeUndefined();
    expect(pgTypeName(424_242)).toBeUndefined();
  });
});

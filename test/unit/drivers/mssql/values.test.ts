import { describe, expect, it } from 'vitest';
import { ExactText } from '../../../../src/drivers/mssql/exact-values';
import { catalogText, mssqlTypeName, toCellValue } from '../../../../src/drivers/mssql/values';
import { retainedBytes } from '../../../../src/shared/binary-bytes';

const type = (name: string, extra: Record<string, unknown> = {}) => ({ type: { name }, ...extra });

describe('mssqlTypeName', () => {
  it('names fixed types the way SQL does', () => {
    expect(mssqlTypeName(type('Int'))).toBe('int');
    expect(mssqlTypeName(type('NVarChar'))).toBe('nvarchar');
    expect(mssqlTypeName(type('DateTimeOffset'))).toBe('datetimeoffset');
    expect(mssqlTypeName(type('UniqueIdentifier'))).toBe('uniqueidentifier');
    expect(mssqlTypeName(type('Variant'))).toBe('sql_variant');
  });

  it('names the N variants by their length', () => {
    expect(mssqlTypeName(type('IntN', { dataLength: 1 }))).toBe('tinyint');
    expect(mssqlTypeName(type('IntN', { dataLength: 2 }))).toBe('smallint');
    expect(mssqlTypeName(type('IntN', { dataLength: 4 }))).toBe('int');
    expect(mssqlTypeName(type('IntN', { dataLength: 8 }))).toBe('bigint');
    expect(mssqlTypeName(type('IntN'))).toBe('int');
    expect(mssqlTypeName(type('FloatN', { dataLength: 4 }))).toBe('real');
    expect(mssqlTypeName(type('FloatN', { dataLength: 8 }))).toBe('float');
    expect(mssqlTypeName(type('MoneyN', { dataLength: 4 }))).toBe('smallmoney');
    expect(mssqlTypeName(type('MoneyN', { dataLength: 8 }))).toBe('money');
    expect(mssqlTypeName(type('DateTimeN', { dataLength: 4 }))).toBe('smalldatetime');
    expect(mssqlTypeName(type('DateTimeN', { dataLength: 8 }))).toBe('datetime');
  });

  it('names user types by their own name and knows nothing of unknown ones', () => {
    expect(mssqlTypeName(type('UDT', { udtInfo: { typeName: 'HierarchyId' } }))).toBe(
      'hierarchyid',
    );
    expect(mssqlTypeName(type('UDT'))).toBeUndefined();
    expect(mssqlTypeName(type('Martian'))).toBeUndefined();
  });
});

describe('toCellValue', () => {
  it('keeps NULL, booleans, numbers and text', () => {
    expect(toCellValue(null, type('Int'))).toBeNull();
    expect(toCellValue(undefined, type('Int'))).toBeNull();
    expect(toCellValue(true, type('Bit'))).toBe(true);
    expect(toCellValue(1.5, type('Real'))).toBe(1.5);
    expect(toCellValue('héllo', type('NVarChar'))).toBe('héllo');
  });

  it('tags exact values decoded from the bytes', () => {
    expect(toCellValue(new ExactText('decimal', '1.50'), type('DecimalN'))).toEqual({
      kind: 'decimal',
      text: '1.50',
    });
    expect(toCellValue(new ExactText('datetime', '2024-01-01'), type('Date'))).toEqual({
      kind: 'datetime',
      text: '2024-01-01',
    });
  });

  it('keeps BIGINT exact, as a number only when it fits', () => {
    expect(toCellValue('42', type('BigInt'))).toBe(42);
    expect(toCellValue('9223372036854775807', type('IntN', { dataLength: 8 }))).toEqual({
      kind: 'bigint',
      text: '9223372036854775807',
    });
    expect(toCellValue(12n, type('BigInt'))).toBe(12);
    // Text of other types is never taken for a number.
    expect(toCellValue('42', type('VarChar'))).toBe('42');
    expect(toCellValue('42', type('IntN', { dataLength: 4 }))).toBe('42');
  });

  it('turns bytes into a binary value whose full bytes stay in the host', () => {
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const cell = toCellValue(bytes, type('VarBinary'));
    expect(cell).toEqual({ kind: 'binary', size: 4, preview: 'deadbeef' });
    expect(Buffer.from(retainedBytes(cell as never) ?? [])).toEqual(bytes);
  });

  it('writes a Date from sql_variant as UTC text', () => {
    expect(toCellValue(new Date(Date.UTC(2024, 1, 29, 8, 30, 0, 5)), type('Variant'))).toEqual({
      kind: 'datetime',
      text: '2024-02-29 08:30:00.005',
    });
  });

  it('writes anything else as JSON text', () => {
    expect(toCellValue({ a: 1 }, type('UDT'))).toBe('{"a":1}');
  });
});

describe('catalogText', () => {
  it('reads catalog cells as text', () => {
    expect(catalogText('dbo')).toBe('dbo');
    expect(catalogText(7)).toBe('7');
    expect(catalogText(7n)).toBe('7');
    expect(catalogText(new ExactText('decimal', '1.0'))).toBe('1.0');
  });

  it('is undefined for NULL and other values', () => {
    expect(catalogText(null)).toBeUndefined();
    expect(catalogText(undefined)).toBeUndefined();
    expect(catalogText(true)).toBeUndefined();
  });
});

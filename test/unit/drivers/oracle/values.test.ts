import { describe, expect, it } from 'vitest';
import { OracleDateText } from '../../../../src/drivers/oracle/exact-dates';
import {
  intervalText,
  type OracleColumnLike,
  oracleTypeName,
  toCellValue,
} from '../../../../src/drivers/oracle/values';

const col = (dbTypeName?: string, extra: Partial<OracleColumnLike> = {}): OracleColumnLike => ({
  name: 'c',
  ...(dbTypeName === undefined ? {} : { dbTypeName }),
  ...extra,
});

describe('oracleTypeName', () => {
  it('names NUMBER with its precision and a scale other than zero', () => {
    expect(oracleTypeName(col('NUMBER', { precision: 10, scale: 2 }))).toBe('NUMBER(10,2)');
    expect(oracleTypeName(col('NUMBER', { precision: 10, scale: 0 }))).toBe('NUMBER(10)');
    expect(oracleTypeName(col('NUMBER', { precision: 10 }))).toBe('NUMBER(10)');
    expect(oracleTypeName(col('NUMBER', { precision: 5, scale: -2 }))).toBe('NUMBER(5,-2)');
  });

  it('names NUMBER without a precision as plain NUMBER', () => {
    expect(oracleTypeName(col('NUMBER'))).toBe('NUMBER');
    expect(oracleTypeName(col('NUMBER', { precision: 0, scale: -127 }))).toBe('NUMBER');
  });

  it('keeps other type names as the driver gives them', () => {
    expect(oracleTypeName(col('VARCHAR2', { precision: 10 }))).toBe('VARCHAR2');
    expect(oracleTypeName(col('TIMESTAMP WITH TIME ZONE', { precision: 6 }))).toBe(
      'TIMESTAMP WITH TIME ZONE',
    );
    expect(oracleTypeName(col('FLOAT', { precision: 126 }))).toBe('FLOAT');
  });

  it('is undefined when the driver knows no type', () => {
    expect(oracleTypeName(col())).toBeUndefined();
  });
});

describe('toCellValue', () => {
  it('turns null and undefined into NULL', () => {
    expect(toCellValue(null, col('VARCHAR2'))).toBeNull();
    expect(toCellValue(undefined, col('NUMBER'))).toBeNull();
  });

  it('keeps integers that fit as numbers and tags the rest as bigint', () => {
    expect(toCellValue('42', col('NUMBER'))).toBe(42);
    expect(toCellValue('-7', col('NUMBER'))).toBe(-7);
    expect(toCellValue('0', col('FLOAT'))).toBe(0);
    expect(toCellValue('9007199254740991', col('NUMBER'))).toBe(9007199254740991);
    expect(toCellValue('9007199254740993', col('NUMBER'))).toEqual({
      kind: 'bigint',
      text: '9007199254740993',
    });
    expect(toCellValue('-12345678901234567890123456789012345678', col('NUMBER'))).toEqual({
      kind: 'bigint',
      text: '-12345678901234567890123456789012345678',
    });
  });

  it('keeps decimals as exact text and adds the zero Oracle leaves out', () => {
    expect(toCellValue('12.50', col('NUMBER'))).toEqual({ kind: 'decimal', text: '12.50' });
    expect(toCellValue('.5', col('NUMBER'))).toEqual({ kind: 'decimal', text: '0.5' });
    expect(toCellValue('-.5', col('NUMBER'))).toEqual({ kind: 'decimal', text: '-0.5' });
    expect(toCellValue('-0.25', col('NUMBER'))).toEqual({ kind: 'decimal', text: '-0.25' });
    expect(toCellValue('.000000000000000000000000000001', col('FLOAT'))).toEqual({
      kind: 'decimal',
      text: '0.000000000000000000000000000001',
    });
    expect(toCellValue('1E+40', col('NUMBER'))).toEqual({ kind: 'decimal', text: '1E+40' });
  });

  it('leaves text of other types alone, even when it looks like a number', () => {
    expect(toCellValue('00042', col('VARCHAR2'))).toBe('00042');
    expect(toCellValue('.5', col('CHAR'))).toBe('.5');
    expect(toCellValue('', col('CLOB'))).toBe('');
    expect(toCellValue('AAAR3sAAEAAAACXAAA', col('ROWID'))).toBe('AAAR3sAAEAAAACXAAA');
    expect(toCellValue('text', col())).toBe('text');
  });

  it('formats a DATE with whole seconds and a TIMESTAMP by its precision', () => {
    const value = new OracleDateText('2024-02-29', '23:59:58', 123_456_789, undefined);
    expect(toCellValue(value, col('DATE', { precision: 6 }))).toEqual({
      kind: 'datetime',
      text: '2024-02-29 23:59:58',
    });
    expect(toCellValue(value, col('TIMESTAMP', { precision: 3 }))).toEqual({
      kind: 'datetime',
      text: '2024-02-29 23:59:58.123',
    });
    expect(toCellValue(value, col('TIMESTAMP', { precision: 9 }))).toEqual({
      kind: 'datetime',
      text: '2024-02-29 23:59:58.123456789',
    });
    expect(toCellValue(value, col('TIMESTAMP', { precision: 0 }))).toEqual({
      kind: 'datetime',
      text: '2024-02-29 23:59:58',
    });
  });

  it('shows six fraction digits when a timestamp column says no precision', () => {
    const value = new OracleDateText('2024-01-01', '00:00:00', 5_000, 180);
    expect(toCellValue(value, col('TIMESTAMP WITH TIME ZONE'))).toEqual({
      kind: 'datetime',
      text: '2024-01-01 00:00:00.000005 +03:00',
    });
  });

  it('passes numbers and booleans through', () => {
    expect(toCellValue(1.5, col('BINARY_DOUBLE'))).toBe(1.5);
    expect(toCellValue(Number.NaN, col('BINARY_FLOAT'))).toBeNaN();
    expect(toCellValue(true, col('BOOLEAN'))).toBe(true);
    expect(toCellValue(false, col('BOOLEAN'))).toBe(false);
  });

  it('turns bytes into a binary value with a hex preview', () => {
    expect(toCellValue(Buffer.from([0xde, 0xad, 0xbe, 0xef]), col('RAW'))).toEqual({
      kind: 'binary',
      size: 4,
      preview: 'deadbeef',
    });
    expect(toCellValue(Buffer.alloc(0), col('BLOB'))).toEqual({
      kind: 'binary',
      size: 0,
      preview: '',
    });
  });

  it('prints a JS Date in UTC without the T and Z', () => {
    expect(toCellValue(new Date(Date.UTC(2024, 1, 29, 10, 5, 6, 7)), col('DATE'))).toEqual({
      kind: 'datetime',
      text: '2024-02-29 10:05:06.007',
    });
  });

  it('prints intervals the way Oracle does', () => {
    expect(toCellValue({ years: 1, months: 2 }, col('INTERVAL YEAR TO MONTH'))).toBe('+01-02');
    expect(
      toCellValue(
        { days: 3, hours: 4, minutes: 5, seconds: 6, fseconds: 789_000_000 },
        col('INTERVAL DAY TO SECOND'),
      ),
    ).toBe('+03 04:05:06.789000');
  });

  it('turns other objects and arrays into JSON text', () => {
    expect(toCellValue({ a: 1, b: [true, null] }, col('JSON'))).toEqual({
      kind: 'json',
      text: '{"a":1,"b":[true,null]}',
    });
    expect(toCellValue([1, 'x'], col('JSON'))).toEqual({ kind: 'json', text: '[1,"x"]' });
    expect(toCellValue({ years: 1 }, col('VARCHAR2'))).toEqual({
      kind: 'json',
      text: '{"years":1}',
    });
    expect(toCellValue({}, col())).toEqual({ kind: 'json', text: '{}' });
  });
});

describe('intervalText', () => {
  it('writes YEAR TO MONTH with a sign, carrying months into years', () => {
    expect(intervalText({ years: 0, months: 0 })).toBe('+00-00');
    expect(intervalText({ years: 2, months: 11 })).toBe('+02-11');
    expect(intervalText({ months: 14 })).toBe('+01-02');
    expect(intervalText({ years: 123, months: 4 })).toBe('+123-04');
  });

  it('writes a negative YEAR TO MONTH once, in front', () => {
    expect(intervalText({ years: -1, months: -2 })).toBe('-01-02');
    expect(intervalText({ years: 0, months: -5 })).toBe('-00-05');
    expect(intervalText({ years: -3 })).toBe('-03-00');
  });

  it('writes DAY TO SECOND with microseconds from the nanoseconds', () => {
    expect(intervalText({ days: 0, hours: 0, minutes: 0, seconds: 0, fseconds: 0 })).toBe(
      '+00 00:00:00.000000',
    );
    expect(
      intervalText({ days: 12, hours: 23, minutes: 59, seconds: 59, fseconds: 999_999_000 }),
    ).toBe('+12 23:59:59.999999');
    expect(intervalText({ days: 1, fseconds: 1_499 })).toBe('+01 00:00:00.000001');
    expect(intervalText({ days: 1, fseconds: 500 })).toBe('+01 00:00:00.000001');
    expect(intervalText({ days: 1, fseconds: 499 })).toBe('+01 00:00:00.000000');
  });

  it('writes a negative DAY TO SECOND with one sign and positive parts', () => {
    expect(
      intervalText({ days: -1, hours: -2, minutes: -3, seconds: -4, fseconds: -5_000_000 }),
    ).toBe('-01 02:03:04.005000');
    expect(intervalText({ days: 0, hours: 0, minutes: -30, seconds: 0, fseconds: 0 })).toBe(
      '-00 00:30:00.000000',
    );
  });

  it('counts missing or non-numeric parts as zero', () => {
    expect(intervalText({})).toBe('+00 00:00:00.000000');
    expect(intervalText({ days: '5', hours: null })).toBe('+00 00:00:00.000000');
    expect(intervalText({ years: 'x', months: 3 })).toBe('+00-03');
  });
});

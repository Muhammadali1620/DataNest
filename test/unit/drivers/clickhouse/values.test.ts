import { describe, expect, it } from 'vitest';
import { clickhouseText, toCellValue } from '../../../../src/drivers/clickhouse/values';

describe('toCellValue', () => {
  it('keeps NULL', () => {
    expect(toCellValue(null, 'Nullable(String)')).toBeNull();
    expect(toCellValue(undefined, 'String')).toBeNull();
  });

  it('keeps small integers as numbers and big ones exact', () => {
    expect(toCellValue(-128, 'Int8')).toBe(-128);
    expect(toCellValue(4294967295, 'UInt32')).toBe(4294967295);
    expect(toCellValue('42', 'UInt64')).toBe(42);
    expect(toCellValue('18446744073709551615', 'UInt64')).toEqual({
      kind: 'bigint',
      text: '18446744073709551615',
    });
    expect(toCellValue('-170141183460469231731687303715884105728', 'Nullable(Int128)')).toEqual({
      kind: 'bigint',
      text: '-170141183460469231731687303715884105728',
    });
    expect(toCellValue(7, 'Int64')).toBe(7);
  });

  it('reads quoted floats, the non-finite ones too', () => {
    expect(toCellValue(1.5, 'Float32')).toBe(1.5);
    expect(toCellValue('nan', 'Float64')).toBeNaN();
    expect(toCellValue('-nan', 'Float64')).toBeNaN();
    expect(toCellValue('inf', 'Nullable(Float64)')).toBe(Number.POSITIVE_INFINITY);
    expect(toCellValue('+inf', 'Float32')).toBe(Number.POSITIVE_INFINITY);
    expect(toCellValue('-inf', 'Float64')).toBe(Number.NEGATIVE_INFINITY);
    expect(toCellValue('2.5', 'BFloat16')).toBe(2.5);
  });

  it('keeps decimals and dates as the server wrote them', () => {
    expect(toCellValue('12.50', 'Decimal(6, 2)')).toEqual({ kind: 'decimal', text: '12.50' });
    expect(toCellValue('0.1', 'Nullable(Decimal128(10))')).toEqual({
      kind: 'decimal',
      text: '0.1',
    });
    expect(toCellValue('2024-02-29', 'Date')).toEqual({ kind: 'datetime', text: '2024-02-29' });
    expect(toCellValue('1900-01-01', 'Date32')).toEqual({ kind: 'datetime', text: '1900-01-01' });
    expect(toCellValue('2024-12-31 23:59:59.123456', "DateTime64(6, 'UTC')")).toEqual({
      kind: 'datetime',
      text: '2024-12-31 23:59:59.123456',
    });
    expect(toCellValue('12:00:00', 'Time')).toEqual({ kind: 'datetime', text: '12:00:00' });
    expect(toCellValue('12:00:00.5', 'Time64(3)')).toEqual({
      kind: 'datetime',
      text: '12:00:00.5',
    });
  });

  it('keeps text, UUIDs, enums and addresses as strings', () => {
    expect(toCellValue('low', 'LowCardinality(String)')).toBe('low');
    expect(toCellValue('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'UUID')).toBe(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    );
    expect(toCellValue('b', "Enum8('a' = 1, 'b' = 2)")).toBe('b');
    expect(toCellValue('192.168.0.1', 'IPv4')).toBe('192.168.0.1');
  });

  it('keeps booleans', () => {
    expect(toCellValue(true, 'Bool')).toBe(true);
    expect(toCellValue(false, 'Nullable(Bool)')).toBe(false);
  });

  it('shows arrays, maps and JSON as JSON, tuples as tuples', () => {
    expect(toCellValue([1, 2, 3], 'Array(Int32)')).toEqual({ kind: 'json', text: '[1,2,3]' });
    expect(toCellValue({ one: 1 }, 'Map(String, Int32)')).toEqual({
      kind: 'json',
      text: '{"one":1}',
    });
    expect(toCellValue(['x', 7], 'Tuple(String, Int32)')).toBe("('x', 7)");
    expect(toCellValue({ a: 'x' }, 'Tuple(a String)')).toEqual({ kind: 'json', text: '{"a":"x"}' });
    expect(toCellValue([], 'Array(String)')).toEqual({ kind: 'json', text: '[]' });
  });
});

describe('clickhouseText', () => {
  it('writes scalars as literals', () => {
    expect(clickhouseText(null)).toBe('NULL');
    expect(clickhouseText(undefined)).toBe('NULL');
    expect(clickhouseText(3)).toBe('3');
    expect(clickhouseText(true)).toBe('true');
    expect(clickhouseText("O'Brien \\")).toBe("'O\\'Brien \\\\'");
  });

  it('writes arrays, maps and tuples in the server text form', () => {
    expect(clickhouseText([1, 'a', null])).toBe("[1, 'a', NULL]");
    expect(clickhouseText({ one: 1, "it's": [2] })).toBe("{'one': 1, 'it\\'s': [2]}");
    expect(clickhouseText(['x', 7], true)).toBe("('x', 7)");
    expect(clickhouseText([['x', 1]], true)).toBe("(['x', 1])");
    expect(clickhouseText([])).toBe('[]');
    expect(clickhouseText({})).toBe('{}');
  });
});

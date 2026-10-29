import { describe, expect, it } from 'vitest';
import { clickhouseBareType, isClickhouseNullable } from '../../../src/shared/clickhouse-types';

describe('clickhouseBareType', () => {
  it('takes off Nullable and LowCardinality, however they nest', () => {
    expect(clickhouseBareType('Nullable(String)')).toBe('String');
    expect(clickhouseBareType('LowCardinality(String)')).toBe('String');
    expect(clickhouseBareType('LowCardinality(Nullable(String))')).toBe('String');
    expect(clickhouseBareType(' nullable(Int32) ')).toBe('Int32');
  });

  it('keeps the arguments of the type inside', () => {
    expect(clickhouseBareType("Nullable(DateTime64(6, 'UTC'))")).toBe("DateTime64(6, 'UTC')");
    expect(clickhouseBareType('Nullable(Decimal(38, 10))')).toBe('Decimal(38, 10)');
  });

  it('leaves other types as they are, wrappers inside them too', () => {
    expect(clickhouseBareType('Array(Nullable(Int32))')).toBe('Array(Nullable(Int32))');
    expect(clickhouseBareType('decimal(10,2)')).toBe('decimal(10,2)');
    expect(clickhouseBareType('')).toBe('');
  });
});

describe('isClickhouseNullable', () => {
  it('is true for Nullable, also under LowCardinality', () => {
    expect(isClickhouseNullable('Nullable(String)')).toBe(true);
    expect(isClickhouseNullable('LowCardinality(Nullable(String))')).toBe(true);
    expect(isClickhouseNullable(' nullable(UInt8)')).toBe(true);
  });

  it('is false for everything else', () => {
    expect(isClickhouseNullable('String')).toBe(false);
    expect(isClickhouseNullable('LowCardinality(String)')).toBe(false);
    expect(isClickhouseNullable('Array(Nullable(Int32))')).toBe(false);
  });
});

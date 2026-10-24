import { describe, expect, it } from 'vitest';
import { toCellValue } from '../../../../src/drivers/sqlite/values';

describe('toCellValue (sqlite)', () => {
  it('passes null through and keeps primitives', () => {
    expect(toCellValue(null)).toBeNull();
    expect(toCellValue(undefined)).toBeNull();
    expect(toCellValue('text')).toBe('text');
    expect(toCellValue(1.5)).toBe(1.5);
    expect(toCellValue(true)).toBe(true);
  });

  it('keeps safe bigints as numbers and tags the big ones', () => {
    expect(toCellValue(42n)).toBe(42);
    expect(toCellValue(-42n)).toBe(-42);
    expect(toCellValue(9223372036854775807n)).toEqual({
      kind: 'bigint',
      text: '9223372036854775807',
    });
  });

  it('drops non-finite numbers to NULL', () => {
    expect(toCellValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toCellValue(Number.NaN)).toBeNull();
  });

  it('converts blobs to a sized hex preview', () => {
    expect(toCellValue(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toEqual({
      kind: 'binary',
      size: 4,
      preview: 'deadbeef',
    });
  });
});

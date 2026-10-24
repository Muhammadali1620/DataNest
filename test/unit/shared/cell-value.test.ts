import { describe, expect, it } from 'vitest';
import {
  cellValueSchema,
  isTaggedValue,
  MAX_CELL_TEXT_LENGTH,
  MAX_COLUMNS,
  resultRowSchema,
  type CellValue,
} from '../../../src/shared/cell-value';

describe('isTaggedValue', () => {
  it('is true only for the tagged objects', () => {
    expect(isTaggedValue({ kind: 'bigint', text: '1' })).toBe(true);
    expect(isTaggedValue(null)).toBe(false);
    expect(isTaggedValue('text')).toBe(false);
    expect(isTaggedValue(42)).toBe(false);
    expect(isTaggedValue(true)).toBe(false);
  });
});

describe('cellValueSchema', () => {
  it('accepts the plain values', () => {
    expect(cellValueSchema.parse(null)).toBeNull();
    expect(cellValueSchema.parse('text')).toBe('text');
    expect(cellValueSchema.parse(42)).toBe(42);
    expect(cellValueSchema.parse(-1.5)).toBe(-1.5);
    expect(cellValueSchema.parse(true)).toBe(true);
  });

  it('accepts every tagged kind', () => {
    const values: CellValue[] = [
      { kind: 'bigint', text: '9223372036854775807' },
      { kind: 'decimal', text: '1.50' },
      { kind: 'datetime', text: '2024-12-31 23:59:59' },
      { kind: 'json', text: '{"a":1}' },
      { kind: 'binary', size: 4, preview: 'deadbeef' },
    ];
    for (const value of values) {
      expect(cellValueSchema.parse(value)).toEqual(value);
    }
  });

  it('rejects an unknown kind and a wrong shape', () => {
    expect(() => cellValueSchema.parse({ kind: 'secret', text: 'x' })).toThrow();
    expect(() => cellValueSchema.parse({ kind: 'bigint' })).toThrow();
    expect(() => cellValueSchema.parse({ kind: 'binary', size: -1, preview: '' })).toThrow();
    expect(() => cellValueSchema.parse({ kind: 'bigint', text: '1', extra: true })).toThrow();
  });

  it('rejects values that cannot survive the trip', () => {
    expect(() => cellValueSchema.parse(undefined)).toThrow();
    expect(() => cellValueSchema.parse(Number.NaN)).toThrow();
    expect(() => cellValueSchema.parse(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => cellValueSchema.parse([])).toThrow();
    expect(() => cellValueSchema.parse(() => 1)).toThrow();
  });

  it('caps the text of a single cell', () => {
    expect(cellValueSchema.parse('x'.repeat(MAX_CELL_TEXT_LENGTH))).toHaveLength(
      MAX_CELL_TEXT_LENGTH,
    );
    // A union reports one combined failure rather than the member's own message.
    expect(() => cellValueSchema.parse('x'.repeat(MAX_CELL_TEXT_LENGTH + 1))).toThrow(
      'does not match any allowed shape',
    );
  });

  it('does not accept a prototype-polluting payload', () => {
    const payload = JSON.parse('{"kind":"bigint","text":"1","__proto__":{"evil":true}}') as unknown;
    expect(() => cellValueSchema.parse(payload)).toThrow();
  });
});

describe('resultRowSchema', () => {
  it('accepts a row of mixed values', () => {
    const row = [1, 'text', null, true, { kind: 'decimal', text: '1.00' }];
    expect(resultRowSchema.parse(row)).toEqual(row);
  });

  it('accepts an empty row', () => {
    expect(resultRowSchema.parse([])).toEqual([]);
  });

  it('rejects something that is not an array', () => {
    expect(() => resultRowSchema.parse({ 0: 1 })).toThrow('expected array');
  });

  it('rejects a row with a bad cell, naming its position', () => {
    expect(() => resultRowSchema.parse([1, undefined])).toThrow('[1]');
  });

  it('caps how many columns a row may have', () => {
    expect(() => resultRowSchema.parse(Array.from({ length: MAX_COLUMNS + 1 }, () => 1))).toThrow(
      'at most',
    );
  });
});

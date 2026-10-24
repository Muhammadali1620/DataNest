import { describe, expect, it } from 'vitest';
import {
  cellJson,
  cellText,
  hasAllBytes,
  isNumericValue,
  isStructuredValue,
} from '../../../src/shared/cell-text';
import type { CellValue } from '../../../src/shared/cell-value';

describe('cellText', () => {
  it('turns NULL into nothing by default, which is what CSV and TSV want', () => {
    expect(cellText(null)).toBe('');
  });

  it('lets the caller choose what NULL looks like', () => {
    expect(cellText(null, { nullText: 'NULL' })).toBe('NULL');
    expect(cellText(null, { nullText: '\\N' })).toBe('\\N');
  });

  it('keeps strings exactly, including whitespace and newlines', () => {
    expect(cellText('  spaced  ')).toBe('  spaced  ');
    expect(cellText('two\nlines')).toBe('two\nlines');
    expect(cellText('')).toBe('');
  });

  it('writes numbers and booleans plainly', () => {
    expect(cellText(42)).toBe('42');
    expect(cellText(-1.5)).toBe('-1.5');
    expect(cellText(0)).toBe('0');
    expect(cellText(true)).toBe('true');
    expect(cellText(false)).toBe('false');
  });

  it('never rounds a bigint or a decimal', () => {
    expect(cellText({ kind: 'bigint', text: '9223372036854775807' })).toBe('9223372036854775807');
    expect(cellText({ kind: 'decimal', text: '12345678901234567890.0123456789' })).toBe(
      '12345678901234567890.0123456789',
    );
    expect(cellText({ kind: 'decimal', text: '1.50' })).toBe('1.50');
  });

  it('keeps a timestamp exactly as the server spelled it', () => {
    expect(cellText({ kind: 'datetime', text: '2024-12-31 23:59:59.123456' })).toBe(
      '2024-12-31 23:59:59.123456',
    );
    expect(cellText({ kind: 'datetime', text: '2024-06-15 12:00:00+00' })).toBe(
      '2024-06-15 12:00:00+00',
    );
  });

  it('keeps JSON text as it came', () => {
    expect(cellText({ kind: 'json', text: '{"a": 1}' })).toBe('{"a": 1}');
  });

  it('writes binary as hex, marking data that did not all travel', () => {
    expect(cellText({ kind: 'binary', size: 4, preview: 'deadbeef' })).toBe('0xdeadbeef');
    expect(cellText({ kind: 'binary', size: 100, preview: 'deadbeef' })).toBe('0xdeadbeef…');
    expect(
      cellText({ kind: 'binary', size: 100, preview: 'deadbeef' }, { binarySuffix: ' (cut)' }),
    ).toBe('0xdeadbeef (cut)');
  });

  it('writes an empty binary value as plain 0x', () => {
    expect(cellText({ kind: 'binary', size: 0, preview: '' })).toBe('0x');
  });
});

describe('hasAllBytes', () => {
  it('compares the hex length with the real size', () => {
    expect(hasAllBytes(4, 'deadbeef')).toBe(true);
    expect(hasAllBytes(5, 'deadbeef')).toBe(false);
    expect(hasAllBytes(0, '')).toBe(true);
  });
});

describe('isNumericValue', () => {
  it('is true for numbers and for exact numeric text', () => {
    expect(isNumericValue(42)).toBe(true);
    expect(isNumericValue({ kind: 'bigint', text: '1' })).toBe(true);
    expect(isNumericValue({ kind: 'decimal', text: '1.0' })).toBe(true);
  });

  it('is false for everything else, including numeric-looking strings', () => {
    for (const value of [
      null,
      '42',
      true,
      { kind: 'datetime', text: '2024-01-01' },
      { kind: 'json', text: '1' },
      { kind: 'binary', size: 1, preview: 'ff' },
    ] satisfies CellValue[]) {
      expect(isNumericValue(value)).toBe(false);
    }
  });
});

describe('isStructuredValue', () => {
  it('is true for JSON and binary, which a viewer can expand', () => {
    expect(isStructuredValue({ kind: 'json', text: '{}' })).toBe(true);
    expect(isStructuredValue({ kind: 'binary', size: 1, preview: 'ff' })).toBe(true);
    expect(isStructuredValue('text')).toBe(false);
    expect(isStructuredValue(null)).toBe(false);
  });
});

describe('cellJson', () => {
  it('keeps JSON-native values as themselves', () => {
    expect(cellJson(null)).toBeNull();
    expect(cellJson(42)).toBe(42);
    expect(cellJson(true)).toBe(true);
    expect(cellJson('text')).toBe('text');
  });

  it('keeps exact numbers as strings, because JSON numbers would round them', () => {
    expect(cellJson({ kind: 'bigint', text: '9223372036854775807' })).toBe('9223372036854775807');
    expect(cellJson({ kind: 'decimal', text: '1.50' })).toBe('1.50');
  });

  it('embeds a JSON column as real JSON', () => {
    expect(cellJson({ kind: 'json', text: '{"a":[1,2]}' })).toEqual({ a: [1, 2] });
  });

  it('keeps a broken JSON column as text instead of failing', () => {
    expect(cellJson({ kind: 'json', text: 'not json' })).toBe('not json');
  });

  it('writes a timestamp and binary as text', () => {
    expect(cellJson({ kind: 'datetime', text: '2024-01-01 00:00:00' })).toBe('2024-01-01 00:00:00');
    expect(cellJson({ kind: 'binary', size: 4, preview: 'deadbeef' })).toBe('0xdeadbeef');
  });

  it('survives a trip through JSON.stringify', () => {
    const row: CellValue[] = [
      null,
      1,
      'text',
      { kind: 'bigint', text: '9007199254740993' },
      { kind: 'json', text: '{"nested":{"a":1}}' },
    ];
    const json = JSON.stringify(row.map(cellJson));
    expect(JSON.parse(json)).toEqual([null, 1, 'text', '9007199254740993', { nested: { a: 1 } }]);
  });
});

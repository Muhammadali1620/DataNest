import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../src/shared/cell-value';
import { needsQuoting, toTsv, tsvField } from '../../../src/shared/tsv';

describe('needsQuoting', () => {
  it('is true for text a spreadsheet would split or misread', () => {
    expect(needsQuoting('a\tb')).toBe(true);
    expect(needsQuoting('a\nb')).toBe(true);
    expect(needsQuoting('a\r\nb')).toBe(true);
    expect(needsQuoting('say "hi"')).toBe(true);
  });

  it('is false for ordinary text', () => {
    expect(needsQuoting('plain')).toBe(false);
    expect(needsQuoting('')).toBe(false);
    expect(needsQuoting('a, b; c')).toBe(false);
  });
});

describe('tsvField', () => {
  it('leaves ordinary text alone', () => {
    expect(tsvField('plain')).toBe('plain');
  });

  it('quotes and doubles the quotes inside', () => {
    expect(tsvField('say "hi"')).toBe('"say ""hi"""');
    expect(tsvField('a\tb')).toBe('"a\tb"');
    expect(tsvField('two\nlines')).toBe('"two\nlines"');
  });
});

describe('toTsv', () => {
  it('joins cells with tabs and rows with CRLF', () => {
    expect(
      toTsv([
        [1, 'a'],
        [2, 'b'],
      ]),
    ).toBe('1\ta\r\n2\tb');
  });

  it('writes a single cell with no separators at all', () => {
    expect(toTsv([[42]])).toBe('42');
  });

  it('writes NULL as an empty cell, which pastes as blank', () => {
    expect(toTsv([[null, 'x']])).toBe('\tx');
  });

  it('can label NULL when the caller wants it visible', () => {
    expect(toTsv([[null]], { nullText: 'NULL' })).toBe('NULL');
  });

  it('keeps exact numbers as text, so a spreadsheet does not round them', () => {
    const row: CellValue[] = [
      { kind: 'bigint', text: '9223372036854775807' },
      { kind: 'decimal', text: '1.50' },
    ];
    expect(toTsv([row])).toBe('9223372036854775807\t1.50');
  });

  it('quotes values that contain tabs or newlines', () => {
    expect(toTsv([['one\ttwo', 'three\nfour']])).toBe('"one\ttwo"\t"three\nfour"');
  });

  it('adds a header row when asked', () => {
    expect(toTsv([[1]], { header: ['id'] })).toBe('id\r\n1');
  });

  it('quotes a header that needs it', () => {
    expect(toTsv([[1]], { header: ['a\tb'] })).toBe('"a\tb"\r\n1');
  });

  it('writes just the header when there are no rows', () => {
    expect(toTsv([], { header: ['id', 'name'] })).toBe('id\tname');
  });

  it('is empty for nothing at all', () => {
    expect(toTsv([])).toBe('');
  });

  it('writes dates, JSON and binary the way the serializer does', () => {
    const row: CellValue[] = [
      { kind: 'datetime', text: '2024-12-31 23:59:59' },
      { kind: 'json', text: '{"a":1}' },
      { kind: 'binary', size: 2, preview: 'abcd' },
    ];
    // JSON carries quotes, so TSV quotes it to keep it inside one cell.
    expect(toTsv([row])).toBe('2024-12-31 23:59:59\t"{""a"":1}"\t0xabcd');
  });

  it('round-trips as many columns as the row has', () => {
    const wide = Array.from({ length: 50 }, (_, index) => index);
    expect(toTsv([wide]).split('\t')).toHaveLength(50);
  });
});

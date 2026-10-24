import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../src/shared/cell-value';
import { csvField, DEFAULT_DELIMITER, needsQuoting, toCsv } from '../../../src/shared/csv';

describe('needsQuoting', () => {
  it('is true for anything a reader could misparse', () => {
    expect(needsQuoting('a,b', ',')).toBe(true);
    expect(needsQuoting('say "hi"', ',')).toBe(true);
    expect(needsQuoting('two\nlines', ',')).toBe(true);
    expect(needsQuoting('carriage\rreturn', ',')).toBe(true);
    expect(needsQuoting(' leading', ',')).toBe(true);
    expect(needsQuoting('trailing ', ',')).toBe(true);
  });

  it('follows the delimiter in use', () => {
    expect(needsQuoting('a;b', ',')).toBe(false);
    expect(needsQuoting('a;b', ';')).toBe(true);
  });

  it('is false for ordinary text', () => {
    expect(needsQuoting('plain', ',')).toBe(false);
    expect(needsQuoting('', ',')).toBe(false);
  });
});

describe('csvField', () => {
  it('quotes only when needed and doubles inner quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('uses the comma by default', () => {
    expect(DEFAULT_DELIMITER).toBe(',');
  });
});

describe('toCsv', () => {
  it('writes rows separated by CRLF and ends the file with one', () => {
    expect(
      toCsv([
        [1, 'a'],
        [2, 'b'],
      ]),
    ).toBe('1,a\r\n2,b\r\n');
  });

  it('writes the header first when given', () => {
    expect(toCsv([[1]], { header: ['id'] })).toBe('id\r\n1\r\n');
  });

  it('writes NULL as an empty field, which readers see as missing', () => {
    expect(toCsv([[null, 1]])).toBe(',1\r\n');
  });

  it('can label NULL instead', () => {
    expect(toCsv([[null]], { nullText: 'NULL' })).toBe('NULL\r\n');
  });

  it('keeps exact numbers unrounded and unquoted', () => {
    const row: CellValue[] = [
      { kind: 'bigint', text: '9223372036854775807' },
      { kind: 'decimal', text: '1.50' },
    ];
    expect(toCsv([row])).toBe('9223372036854775807,1.50\r\n');
  });

  it('quotes values containing the delimiter, quotes or newlines', () => {
    expect(toCsv([['a,b', 'say "hi"', 'two\nlines']])).toBe('"a,b","say ""hi""","two\nlines"\r\n');
  });

  it('honours another delimiter, for locales where the comma is a decimal mark', () => {
    expect(toCsv([[1, 'a,b']], { delimiter: ';' })).toBe('1;a,b\r\n');
  });

  it('writes a header-only file when there are no rows', () => {
    expect(toCsv([], { header: ['id', 'name'] })).toBe('id,name\r\n');
  });

  it('is empty for nothing at all', () => {
    expect(toCsv([])).toBe('');
  });

  it('writes dates, JSON and binary the way the serializer does', () => {
    const row: CellValue[] = [
      { kind: 'datetime', text: '2024-12-31 23:59:59' },
      { kind: 'json', text: '{"a":1}' },
      { kind: 'binary', size: 2, preview: 'abcd' },
    ];
    expect(toCsv([row])).toBe('2024-12-31 23:59:59,"{""a"":1}",0xabcd\r\n');
  });
});

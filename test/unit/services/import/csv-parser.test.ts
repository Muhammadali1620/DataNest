import { describe, expect, it } from 'vitest';
import { CsvParser, guessCsv, parseCsv } from '../../../../src/services/import/csv-parser';

function inParts(text: string, size: number, delimiter = ','): ReturnType<typeof parseCsv> {
  const parser = new CsvParser(delimiter);
  const records = [];
  for (let offset = 0; offset < text.length; offset += size) {
    records.push(...parser.push(text.slice(offset, offset + size)));
  }
  return [...records, ...parser.end()];
}

/** Every way of cutting the text gives the same records. */
function stable(text: string, delimiter = ','): ReturnType<typeof parseCsv> {
  const whole = parseCsv(text, delimiter);
  for (const size of [1, 2, 3, 5, 8]) {
    expect(inParts(text, size, delimiter), `parts of ${size}`).toEqual(whole);
  }
  return whole;
}

describe('CsvParser', () => {
  it('reads records and the line each starts on', () => {
    expect(stable('a,b\n1,2\n3,4\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['1', '2'] },
      { line: 3, fields: ['3', '4'] },
    ]);
  });

  it('keeps delimiters, quotes and line breaks inside quoted fields', () => {
    const records = stable('id,note\n1,"a, b"\n2,"say ""hi"""\n3,"two\nlines"\n4,x\n');
    expect(records.map((record) => record.fields[1])).toEqual([
      'note',
      'a, b',
      'say "hi"',
      'two\nlines',
      'x',
    ]);
    expect(records.map((record) => record.line)).toEqual([1, 2, 3, 4, 6]);
  });

  it('reads CR LF, lone CR and a missing last line break', () => {
    expect(stable('a,b\r\n1,2\r3,4').map((record) => record.fields)).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('skips empty lines but keeps empty fields', () => {
    expect(stable('a,b\n\n,\n1,\n\n').map((record) => record.fields)).toEqual([
      ['a', 'b'],
      ['', ''],
      ['1', ''],
    ]);
  });

  it('keeps text after a closing quote, and quotes inside a bare field', () => {
    expect(stable('"ab"cd,e"f\n').map((record) => record.fields)).toEqual([['abcd', 'e"f']]);
  });

  it('ends an unclosed quoted field at the end of the text', () => {
    expect(stable('1,"open\nstill').map((record) => record.fields)).toEqual([['1', 'open\nstill']]);
  });

  it('reads other delimiters', () => {
    expect(stable('a;b\n"1;2";3', ';').map((record) => record.fields)).toEqual([
      ['a', 'b'],
      ['1;2', '3'],
    ]);
    expect(stable('a\tb\n1\t2', '\t').map((record) => record.fields)[1]).toEqual(['1', '2']);
  });

  it('gives nothing for empty text', () => {
    expect(stable('')).toEqual([]);
    expect(stable('\n\r\n')).toEqual([]);
  });

  it('refuses a delimiter that cannot work', () => {
    expect(() => new CsvParser('"')).toThrow();
    expect(() => new CsvParser(',,')).toThrow();
    expect(() => new CsvParser('\n')).toThrow();
  });
});

describe('guessCsv', () => {
  it('finds the delimiter that splits rows evenly', () => {
    expect(guessCsv('a;b;c\n1;2,5;3\n4;5;6\n').delimiter).toBe(';');
    expect(guessCsv('a\tb\n1\t2\n').delimiter).toBe('\t');
    expect(guessCsv('a|b\n1|2\n').delimiter).toBe('|');
    expect(guessCsv('a,b\n1,2\n').delimiter).toBe(',');
  });

  it('ignores a last line cut in the middle', () => {
    expect(guessCsv('a;b\n1;2\n3;4\n"cut, in the mid').delimiter).toBe(';');
  });

  it('falls back to a comma for a single column', () => {
    expect(guessCsv('name\nAnna\nBob\n')).toEqual({ delimiter: ',', header: true });
  });

  it('tells names from data in the first row', () => {
    expect(guessCsv('id,name\n1,Anna\n').header).toBe(true);
    expect(guessCsv('1,Anna\n2,Bob\n').header).toBe(false);
    expect(guessCsv('a,a\n1,2\n').header).toBe(false);
    expect(guessCsv('id,\n1,2\n').header).toBe(false);
  });
});

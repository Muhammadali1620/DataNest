import { describe, expect, it } from 'vitest';
import { binaryValue } from '../../../src/drivers/common/values';
import {
  columnLetters,
  sheetNameOf,
  toXlsx,
  XLSX_MAX_CELL_CHARS,
  XLSX_MAX_COLUMNS,
  XlsxLimitError,
  xmlText,
} from '../../../src/services/xlsx';
import type { CellValue } from '../../../src/shared/cell-value';
import { entryText, unzip } from '../../helpers/unzip';

function sheetOf(header: string[], rows: CellValue[][]): string {
  return entryText(unzip(toXlsx({ header, rows })), 'xl/worksheets/sheet1.xml');
}

describe('columnLetters', () => {
  it('counts like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 16_383].map(columnLetters)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
      'XFD',
    ]);
  });
});

describe('xmlText', () => {
  it('escapes markup and drops characters XML cannot hold', () => {
    expect(xmlText(`a<b>&"c"`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
    expect(xmlText('a\u0000b\u0008c\u000bd')).toBe('abcd');
    expect(xmlText('tab\tnew\nline\r')).toBe('tab\tnew\nline\r');
  });
});

describe('sheetNameOf', () => {
  it('keeps names Excel accepts and repairs the rest', () => {
    expect(sheetNameOf(undefined)).toBe('Result');
    expect(sheetNameOf('   ')).toBe('Result');
    expect(sheetNameOf('a:b/c\\d?e*f[g]h')).toBe('a b c d e f g h');
    expect(sheetNameOf('x'.repeat(50))).toHaveLength(31);
  });
});

describe('toXlsx package', () => {
  const entries = unzip(toXlsx({ header: ['id'], rows: [[1]] }));

  it('holds the parts of a workbook, each readable', () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    for (const entry of entries) {
      expect(entry.data.toString('utf8').startsWith('<?xml')).toBe(true);
    }
  });

  it('starts with the content types part, as Office expects', () => {
    expect(entries[0]?.name).toBe('[Content_Types].xml');
  });

  it('names the sheet', () => {
    const named = unzip(toXlsx({ header: [], rows: [], sheetName: 'People' }));
    expect(entryText(named, 'xl/workbook.xml')).toContain('name="People"');
  });
});

describe('toXlsx cells', () => {
  it('writes a bold header row and freezes it', () => {
    const xml = sheetOf(['id', 'name'], []);
    expect(xml).toContain('<c r="A1" t="inlineStr" s="1"><is><t>id</t></is></c>');
    expect(xml).toContain('<c r="B1" t="inlineStr" s="1"><is><t>name</t></is></c>');
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<dimension ref="A1:B1"/>');
  });

  it('writes numbers as numbers, booleans as booleans and strings inline', () => {
    const xml = sheetOf(['n', 'b', 's'], [[1.5, true, 'hi']]);
    expect(xml).toContain('<c r="A2"><v>1.5</v></c>');
    expect(xml).toContain('<c r="B2" t="b"><v>1</v></c>');
    expect(xml).toContain('<c r="C2" t="inlineStr"><is><t>hi</t></is></c>');
  });

  it('leaves NULL cells out and skips non-finite numbers', () => {
    const xml = sheetOf(['a', 'b', 'c'], [[null, Number.NaN, 'x']]);
    expect(xml).not.toContain('r="A2"');
    expect(xml).not.toContain('r="B2"');
    expect(xml).toContain('r="C2"');
  });

  it('keeps exact numbers numeric only while a double can hold them', () => {
    const xml = sheetOf(
      ['a', 'b', 'c', 'd'],
      [
        [
          { kind: 'decimal', text: '9.90' },
          { kind: 'bigint', text: '9223372036854775807' },
          { kind: 'decimal', text: '-0.5' },
          { kind: 'decimal', text: '0042' },
        ],
      ],
    );
    expect(xml).toContain('<c r="A2"><v>9.90</v></c>');
    expect(xml).toContain('<c r="B2" t="inlineStr"><is><t>9223372036854775807</t></is></c>');
    expect(xml).toContain('<c r="C2"><v>-0.5</v></c>');
    expect(xml).toContain('<c r="D2" t="inlineStr"><is><t>0042</t></is></c>');
  });

  it('writes dates, JSON and other tagged values as text', () => {
    const xml = sheetOf(
      ['d', 'j'],
      [
        [
          { kind: 'datetime', text: '2024-02-29 10:00:00' },
          { kind: 'json', text: '{"a":1}' },
        ],
      ],
    );
    expect(xml).toContain('<t>2024-02-29 10:00:00</t>');
    expect(xml).toContain('&quot;a&quot;');
  });

  it('writes binary as hex, in full when the bytes are known', () => {
    const bytes = new Uint8Array(300).fill(0xcd);
    const xml = sheetOf(
      ['b'],
      [[binaryValue(bytes)], [{ kind: 'binary', size: 3, preview: '010203' }]],
    );
    expect(xml).toContain(`0x${'cd'.repeat(300)}`);
    expect(xml).toContain('0x010203');
  });

  it('escapes markup in values and in headers', () => {
    const xml = sheetOf(['<h&>'], [['<script>&']]);
    expect(xml).toContain('<t>&lt;h&amp;&gt;</t>');
    expect(xml).toContain('<t>&lt;script&gt;&amp;</t>');
  });

  it('keeps leading and trailing spaces and line breaks', () => {
    const xml = sheetOf(['s'], [[' padded '], ['two\nlines']]);
    expect(xml).toContain('<t xml:space="preserve"> padded </t>');
    expect(xml).toContain('<t xml:space="preserve">two\nlines</t>');
  });

  it('cuts a text longer than a cell can hold', () => {
    const xml = sheetOf(['s'], [['x'.repeat(XLSX_MAX_CELL_CHARS + 100)]]);
    const text = /<t>(x+…?)<\/t>/.exec(xml)?.[1] ?? '';
    expect(text).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  it('pads a short row and ignores cells past the header', () => {
    const xml = sheetOf(['a', 'b'], [[1], [1, 2, 3]]);
    expect(xml).not.toContain('r="B2"');
    expect(xml).not.toContain('r="C3"');
    expect(xml).toContain('r="B3"');
  });

  it('sizes columns to their content within bounds', () => {
    const xml = sheetOf(['id', 'text'], [[1, 'x'.repeat(100)]]);
    expect(xml).toContain('<col min="1" max="1" width="8"');
    expect(xml).toContain('<col min="2" max="2" width="60"');
  });

  it('writes an empty result as a header-only sheet', () => {
    const xml = sheetOf(['a'], []);
    expect(xml).toContain('<sheetData><row r="1">');
    expect(xml).not.toContain('<row r="2">');
  });
});

describe('toXlsx limits', () => {
  it('refuses more columns than a sheet has', () => {
    const header = Array.from({ length: XLSX_MAX_COLUMNS + 1 }, (_, i) => `c${i}`);
    expect(() => toXlsx({ header, rows: [] })).toThrow(XlsxLimitError);
  });

  it('refuses more rows than a sheet has', () => {
    const rows = { length: 1_048_576 } as unknown as CellValue[][];
    expect(() => toXlsx({ header: ['a'], rows })).toThrow(XlsxLimitError);
  });
});

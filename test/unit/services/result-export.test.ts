import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../src/shared/cell-value';
import {
  columnNames,
  EXPORT_FORMATS,
  exportResult,
  extensionOf,
  isExportFormat,
  suggestedFileName,
} from '../../../src/services/result-export';

const columns = [{ name: 'id' }, { name: 'email' }];
const rows: CellValue[][] = [
  [1, 'alice@example.com'],
  [2, null],
];

describe('exportResult', () => {
  describe('csv', () => {
    it('writes a header and every row', () => {
      expect(exportResult({ columns, rows }, 'csv')).toBe(
        'id,email\r\n1,alice@example.com\r\n2,\r\n',
      );
    });

    it('writes a header-only file for an empty result', () => {
      expect(exportResult({ columns, rows: [] }, 'csv')).toBe('id,email\r\n');
    });
  });

  describe('json', () => {
    it('writes one object per row, keyed by column name', () => {
      const text = exportResult({ columns, rows }, 'json');
      expect(JSON.parse(text)).toEqual([
        { id: 1, email: 'alice@example.com' },
        { id: 2, email: null },
      ]);
    });

    it('keeps exact numbers as strings, so nothing is rounded', () => {
      const text = exportResult(
        {
          columns: [{ name: 'big' }, { name: 'money' }],
          rows: [
            [
              { kind: 'bigint', text: '9007199254740993' },
              { kind: 'decimal', text: '1.50' },
            ],
          ],
        },
        'json',
      );
      expect(JSON.parse(text)).toEqual([{ big: '9007199254740993', money: '1.50' }]);
    });

    it('embeds a JSON column as real JSON', () => {
      const text = exportResult(
        { columns: [{ name: 'attributes' }], rows: [[{ kind: 'json', text: '{"a":[1,2]}' }]] },
        'json',
      );
      expect(JSON.parse(text)).toEqual([{ attributes: { a: [1, 2] } }]);
    });

    it('writes an empty array for an empty result', () => {
      expect(JSON.parse(exportResult({ columns, rows: [] }, 'json'))).toEqual([]);
    });

    it('ends the file with a newline', () => {
      expect(exportResult({ columns, rows }, 'json').endsWith('\n')).toBe(true);
    });

    it('fills in a missing cell as null rather than dropping the key', () => {
      const text = exportResult({ columns, rows: [[1]] }, 'json');
      expect(JSON.parse(text)).toEqual([{ id: 1, email: null }]);
    });
  });
});

describe('columnNames', () => {
  it('uses the names the driver reported', () => {
    expect(columnNames(columns)).toEqual(['id', 'email']);
  });

  it('numbers duplicates, so no column is lost in JSON', () => {
    expect(columnNames([{ name: 'id' }, { name: 'id' }, { name: 'id' }])).toEqual([
      'id',
      'id_2',
      'id_3',
    ]);
  });

  it('names an unnamed column by its position', () => {
    expect(columnNames([{ name: '' }, { name: 'x' }])).toEqual(['column1', 'x']);
  });

  it('keeps every column distinct', () => {
    const names = columnNames([{ name: 'a' }, { name: 'a' }, { name: '' }, { name: 'a_2' }]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('suggestedFileName', () => {
  it('builds a name from the statement', () => {
    expect(suggestedFileName('SELECT * FROM customers', 'csv')).toBe('select-from-customers.csv');
  });

  it('uses the right extension', () => {
    expect(suggestedFileName('SELECT 1', 'json')).toBe('select-1.json');
    expect(extensionOf('csv')).toBe('csv');
    expect(extensionOf('json')).toBe('json');
  });

  it('keeps the name short and free of path characters', () => {
    const name = suggestedFileName(
      'SELECT a, b, c FROM /etc/passwd WHERE x = "../../secret" AND y = 1',
      'csv',
    );
    expect(name.length).toBeLessThanOrEqual(45);
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).toMatch(/^[a-z0-9-]+\.csv$/);
  });

  it('falls back to a plain name when the statement has no words', () => {
    expect(suggestedFileName('   ', 'csv')).toBe('result.csv');
    expect(suggestedFileName('!!!', 'json')).toBe('result.json');
  });
});

describe('isExportFormat', () => {
  it('accepts the formats the extension writes', () => {
    for (const format of EXPORT_FORMATS) {
      expect(isExportFormat(format)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isExportFormat('xlsx')).toBe(false);
    expect(isExportFormat(undefined)).toBe(false);
    expect(isExportFormat('')).toBe(false);
  });
});

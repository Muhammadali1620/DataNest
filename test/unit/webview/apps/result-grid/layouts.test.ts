import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import { jsonOf, rowsToJson, transpose } from '../../../../../webview/src/apps/result-grid/layouts';

describe('jsonOf', () => {
  it.each([null, 1, 'a', true, false, 2.5])('keeps %s as it is', (value) => {
    expect(jsonOf(value)).toBe(value);
  });

  it('parses a JSON value, and keeps broken JSON as text', () => {
    expect(jsonOf({ kind: 'json', text: '{"a":[1,2]}' })).toEqual({ a: [1, 2] });
    expect(jsonOf({ kind: 'json', text: '{oops' })).toBe('{oops');
  });

  it('writes a binary value as its size', () => {
    expect(jsonOf({ kind: 'binary', size: 12, preview: '0a' })).toBe('<12 bytes>');
  });

  it('writes big numbers, decimals and dates as the text the grid shows', () => {
    expect(jsonOf({ kind: 'bigint', text: '9007199254740993' })).toBe('9007199254740993');
    expect(jsonOf({ kind: 'decimal', text: '10.50' })).toBe('10.50');
    expect(jsonOf({ kind: 'datetime', text: '2026-01-02 03:04:05' })).toBe('2026-01-02 03:04:05');
  });
});

describe('rowsToJson', () => {
  const columns = [{ name: 'id' }, { name: 'meta' }];

  it('makes an array of objects with a key per column', () => {
    const rows: CellValue[][] = [
      [1, { kind: 'json', text: '{"x":1}' }],
      [2, null],
    ];
    expect(JSON.parse(rowsToJson(columns, rows))).toEqual([
      { id: 1, meta: { x: 1 } },
      { id: 2, meta: null },
    ]);
  });

  it('is indented to be read', () => {
    expect(rowsToJson(columns, [[1, null]])).toContain('\n  {');
  });

  it('is an empty array for no rows', () => {
    expect(rowsToJson(columns, [])).toBe('[]');
  });

  it('fills a short row with NULL', () => {
    expect(JSON.parse(rowsToJson(columns, [[1]]))).toEqual([{ id: 1, meta: null }]);
  });
});

describe('transpose', () => {
  it('runs the fields down and the rows across', () => {
    const turned = transpose(
      [{ name: 'id' }, { name: 'name' }],
      [
        [1, 'a'],
        [2, 'b'],
      ],
    );
    expect(turned.heads).toEqual([1, 2]);
    expect(turned.lines).toEqual([
      { name: 'id', cells: [1, 2] },
      { name: 'name', cells: ['a', 'b'] },
    ]);
  });

  it('has the fields and no heads for no rows', () => {
    expect(transpose([{ name: 'id' }], [])).toEqual({
      heads: [],
      lines: [{ name: 'id', cells: [] }],
    });
  });

  it('fills a short row with NULL', () => {
    expect(transpose([{ name: 'a' }, { name: 'b' }], [[1]]).lines[1]?.cells).toEqual([null]);
  });
});

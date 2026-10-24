import { describe, expect, it } from 'vitest';
import { cellMatches, findRows } from '../../../src/shared/cell-search';
import type { CellValue } from '../../../src/shared/cell-value';

describe('cellMatches', () => {
  it('finds text anywhere in the value, ignoring case', () => {
    expect(cellMatches('alice@example.com', 'EXAMPLE')).toBe(true);
    expect(cellMatches('Alice', 'ali')).toBe(true);
    expect(cellMatches('Alice', 'bob')).toBe(false);
  });

  it('searches numbers by their text', () => {
    expect(cellMatches(12_345, '234')).toBe(true);
    expect(cellMatches({ kind: 'bigint', text: '9223372036854775807' }, '7758')).toBe(true);
  });

  it('finds NULL by its label, which is what the cell shows', () => {
    expect(cellMatches(null, 'null')).toBe(true);
    expect(cellMatches(null, 'NU')).toBe(true);
    expect(cellMatches(null, 'zero')).toBe(false);
  });

  it('searches dates, JSON and binary by their text', () => {
    expect(cellMatches({ kind: 'datetime', text: '2024-12-31 23:59:59' }, '12-31')).toBe(true);
    expect(cellMatches({ kind: 'json', text: '{"colour":"red"}' }, 'colour')).toBe(true);
    expect(cellMatches({ kind: 'binary', size: 2, preview: 'dead' }, 'dead')).toBe(true);
  });

  it('matches booleans by word', () => {
    expect(cellMatches(true, 'tru')).toBe(true);
    expect(cellMatches(false, 'false')).toBe(true);
  });

  it('never matches an empty needle', () => {
    expect(cellMatches('anything', '')).toBe(false);
    expect(cellMatches(null, '')).toBe(false);
  });
});

describe('findRows', () => {
  const rows: CellValue[][] = [
    [1, 'alice@example.com'],
    [2, 'bob@test.org'],
    [3, null],
    [4, 'carol@example.com'],
  ];

  it('returns the indexes of matching rows in order', () => {
    expect(findRows(rows, 'example.com')).toEqual({ rows: [0, 3], total: 2 });
  });

  it('matches on any column', () => {
    expect(findRows(rows, '2').rows).toEqual([1]);
  });

  it('finds rows by their NULL cells', () => {
    expect(findRows(rows, 'null').rows).toEqual([2]);
  });

  it('reports nothing for a needle that is not there', () => {
    expect(findRows(rows, 'nobody')).toEqual({ rows: [], total: 0 });
  });

  it('ignores a blank search', () => {
    expect(findRows(rows, '')).toEqual({ rows: [], total: 0 });
    expect(findRows(rows, '   ')).toEqual({ rows: [], total: 0 });
  });

  it('caps the indexes it returns but still counts them all', () => {
    const many: CellValue[][] = Array.from({ length: 50 }, () => ['match']);
    const hits = findRows(many, 'match', 10);
    expect(hits.rows).toHaveLength(10);
    expect(hits.total).toBe(50);
  });

  it('searches an empty result without complaint', () => {
    expect(findRows([], 'x')).toEqual({ rows: [], total: 0 });
  });
});

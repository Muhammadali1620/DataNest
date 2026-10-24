import { describe, expect, it } from 'vitest';
import { compareCells, sortRows } from '../../../src/shared/cell-compare';
import type { CellValue } from '../../../src/shared/cell-value';

/** Values in the order the comparator should produce. */
function sorted(values: CellValue[]): CellValue[] {
  return [...values].sort(compareCells);
}

describe('compareCells', () => {
  it('orders numbers numerically, not as text', () => {
    expect(sorted([10, 9, 100, 1])).toEqual([1, 9, 10, 100]);
    expect(sorted([-5, 3, 0])).toEqual([-5, 0, 3]);
    expect(sorted([1.5, 1.25, 1.75])).toEqual([1.25, 1.5, 1.75]);
  });

  it('orders exact numbers without squeezing them into a double', () => {
    const left: CellValue = { kind: 'bigint', text: '9007199254740993' };
    const right: CellValue = { kind: 'bigint', text: '9007199254740992' };
    // Both become the same double; only exact text can tell them apart.
    expect(Number(left.text) === Number(right.text)).toBe(true);
    expect(compareCells(left, right)).toBeGreaterThan(0);
    expect(compareCells(right, left)).toBeLessThan(0);
  });

  it('orders decimals by value, not by digit count', () => {
    const values = [
      { kind: 'decimal', text: '9.99' },
      { kind: 'decimal', text: '10.00' },
      { kind: 'decimal', text: '2.50' },
    ] as const;
    const texts = [...values].sort(compareCells).map((value) => value.text);
    expect(texts).toEqual(['2.50', '9.99', '10.00']);
  });

  it('treats trailing zeros as equal value', () => {
    expect(compareCells({ kind: 'decimal', text: '1.50' }, { kind: 'decimal', text: '1.5' })).toBe(
      0,
    );
  });

  it('orders text case-insensitively but stably', () => {
    expect(sorted(['banana', 'Apple', 'cherry'])).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('orders text with numbers inside the way a human reads it', () => {
    expect(sorted(['row-10', 'row-2', 'row-1'])).toEqual(['row-1', 'row-2', 'row-10']);
  });

  it('puts NULL after every value', () => {
    expect(sorted([null, 5, null, 1])).toEqual([1, 5, null, null]);
    expect(compareCells(null, 'anything')).toBeGreaterThan(0);
    expect(compareCells('anything', null)).toBeLessThan(0);
    expect(compareCells(null, null)).toBe(0);
  });

  it('orders booleans false before true', () => {
    expect(sorted([true, false, true])).toEqual([false, true, true]);
  });

  it('orders dates by their text, which is already sortable', () => {
    const values: CellValue[] = [
      { kind: 'datetime', text: '2024-12-31 23:59:59' },
      { kind: 'datetime', text: '2024-01-01 00:00:00' },
    ];
    expect(compareCells(values[0] as CellValue, values[1] as CellValue)).toBeGreaterThan(0);
  });

  it('puts numbers before text in a mixed column', () => {
    expect(compareCells(5, 'apple')).toBeLessThan(0);
    expect(compareCells('apple', 5)).toBeGreaterThan(0);
  });

  it('is antisymmetric for every pair', () => {
    const values: CellValue[] = [
      null,
      0,
      1,
      'a',
      'B',
      true,
      false,
      { kind: 'bigint', text: '10' },
      { kind: 'datetime', text: '2024-01-01' },
    ];
    for (const left of values) {
      for (const right of values) {
        const forward = compareCells(left, right);
        const backward = compareCells(right, left);
        // Summing avoids the -0 vs 0 trap while still proving the signs oppose.
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);
      }
    }
  });
});

describe('sortRows', () => {
  const rows: CellValue[][] = [
    [3, 'c'],
    [1, 'a'],
    [2, 'b'],
  ];

  it('sorts ascending and descending by a column', () => {
    expect(sortRows(rows, 0, 'asc').map((row) => row[0])).toEqual([1, 2, 3]);
    expect(sortRows(rows, 0, 'desc').map((row) => row[0])).toEqual([3, 2, 1]);
  });

  it('sorts by any column', () => {
    expect(sortRows(rows, 1, 'asc').map((row) => row[1])).toEqual(['a', 'b', 'c']);
  });

  it('leaves the input untouched', () => {
    const before = JSON.stringify(rows);
    sortRows(rows, 0, 'desc');
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('keeps NULLs last in both directions', () => {
    const withNulls: CellValue[][] = [[2], [null], [1]];
    expect(sortRows(withNulls, 0, 'asc').map((row) => row[0])).toEqual([1, 2, null]);
    expect(sortRows(withNulls, 0, 'desc').map((row) => row[0])).toEqual([2, 1, null]);
  });

  it('is stable for equal values', () => {
    const ties: CellValue[][] = [
      [1, 'first'],
      [1, 'second'],
      [1, 'third'],
    ];
    expect(sortRows(ties, 0, 'asc').map((row) => row[1])).toEqual(['first', 'second', 'third']);
    expect(sortRows(ties, 0, 'desc').map((row) => row[1])).toEqual(['first', 'second', 'third']);
  });

  it('treats a missing cell as NULL', () => {
    const ragged: CellValue[][] = [[1], [], [0]];
    expect(sortRows(ragged, 0, 'asc').map((row) => row[0])).toEqual([0, 1, undefined]);
  });

  it('handles an empty result and a column that is not there', () => {
    expect(sortRows([], 0, 'asc')).toEqual([]);
    expect(sortRows(rows, 99, 'asc')).toHaveLength(3);
  });
});

import { describe, expect, it } from 'vitest';
import { compareCells, sortRows, sortRowsPaused } from '../../../src/shared/cell-compare';
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

  it('compares a plain number with an exact decimal by its digits', () => {
    // As doubles both are 0.3; the decimal's digits say it is a little more.
    const decimal: CellValue = { kind: 'decimal', text: '0.30000000000000001' };
    expect(compareCells(0.3, decimal)).toBeLessThan(0);
    expect(compareCells(decimal, 0.3)).toBeGreaterThan(0);
    expect(compareCells(2, { kind: 'decimal', text: '2.000' })).toBe(0);
  });

  it('orders negative exact numbers and zeros by value', () => {
    const values: CellValue[] = [
      { kind: 'decimal', text: '-1.5' },
      { kind: 'decimal', text: '-10.25' },
      { kind: 'decimal', text: '007' },
      { kind: 'decimal', text: '0.0' },
    ];
    const texts = [...values].sort(compareCells).map((value) => (value as { text: string }).text);
    expect(texts).toEqual(['-10.25', '-1.5', '0.0', '007']);
  });

  it('orders numbers written as text by value', () => {
    expect(sorted(['100', '20', '3'])).toEqual(['3', '20', '100']);
  });

  it('orders a number spelled with an exponent among other numbers', () => {
    expect(sorted([1e21, 5, -1e21])).toEqual([-1e21, 5, 1e21]);
  });

  it('holds texts the collator cannot tell apart as equal', () => {
    // é written as one code point and as e + a combining accent.
    expect(compareCells('caf\u00e9', 'cafe\u0301')).toBe(0);
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

  it('keeps a missing cell last in both directions, like NULL', () => {
    const ragged: CellValue[][] = [[1], [], [2]];
    expect(sortRows(ragged, 0, 'desc').map((row) => row[0])).toEqual([2, 1, undefined]);
  });

  it('keeps equal texts in server order and texts the collator holds equal together', () => {
    const rows: CellValue[][] = [
      ['b', 1],
      ['caf\u00e9', 2],
      ['a', 3],
      ['cafe\u0301', 4],
      ['b', 5],
    ];
    expect(sortRows(rows, 0, 'asc').map((row) => row[1])).toEqual([3, 1, 5, 2, 4]);
    expect(sortRows(rows, 0, 'desc').map((row) => row[1])).toEqual([2, 4, 1, 5, 3]);
  });

  it('orders a column that mixes every kind of value', () => {
    const rows: CellValue[][] = [
      ['text'],
      [null],
      [{ kind: 'decimal', text: '2.5' }],
      [10],
      [{ kind: 'datetime', text: '2024-01-01 00:00:00' }],
      [{ kind: 'bigint', text: '-3' }],
    ];
    expect(sortRows(rows, 0, 'asc').map((row) => row[0])).toEqual([
      { kind: 'bigint', text: '-3' },
      { kind: 'decimal', text: '2.5' },
      10,
      { kind: 'datetime', text: '2024-01-01 00:00:00' },
      'text',
      null,
    ]);
  });

  it('handles an empty result and a column that is not there', () => {
    expect(sortRows([], 0, 'asc')).toEqual([]);
    expect(sortRows(rows, 99, 'asc')).toHaveLength(3);
  });
});

describe('sortRowsPaused', () => {
  /** Rows of varied values from a fixed seed. */
  function sample(length: number): CellValue[][] {
    let state = 11;
    const next = (): number => (state = (state * 1103515245 + 12345) % 2147483648);
    return Array.from({ length }, () => {
      const pick = next() % 6;
      const value: CellValue =
        pick === 0
          ? null
          : pick === 1
            ? next() % 1000
            : pick === 2
              ? { kind: 'decimal', text: `${next() % 100}.${next() % 100}` }
              : pick === 3
                ? `name ${next() % 300}`
                : pick === 4
                  ? { kind: 'datetime', text: `2024-0${1 + (next() % 9)}-01` }
                  : `Name ${next() % 300}`;
      return [value, next()];
    });
  }

  it('gives exactly the order of sortRows', async () => {
    const rows = sample(3000);
    for (const direction of ['asc', 'desc'] as const) {
      expect(await sortRowsPaused(rows, 0, direction)).toEqual(sortRows(rows, 0, direction));
    }
  });

  it('pauses on a big result and still sorts it', async () => {
    const rows = Array.from({ length: 50_000 }, (_, index) => [`row ${(index * 7919) % 50_000}`]);
    let pauses = 0;
    let clock = 0;
    const sorted = await sortRowsPaused(rows, 0, 'asc', {
      // Each look at the clock is a "millisecond", so slices end often.
      now: () => clock++,
      sliceMs: 5,
      pause: () => {
        pauses++;
        return Promise.resolve();
      },
    });
    expect(pauses).toBeGreaterThan(10);
    expect(sorted.slice(0, 3)).toEqual([['row 0'], ['row 1'], ['row 2']]);
    expect(sorted.at(-1)).toEqual(['row 49999']);
  });

  it('agrees with the pairwise comparator on every pair it orders', async () => {
    const rows = sample(400);
    const sorted = await sortRowsPaused(rows, 0, 'asc');
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]?.[0] ?? null;
      const current = sorted[index]?.[0] ?? null;
      expect(compareCells(previous, current)).toBeLessThanOrEqual(0);
    }
  });
});

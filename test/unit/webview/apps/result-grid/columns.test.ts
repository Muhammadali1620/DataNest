import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import {
  clamp,
  DEFAULT_COLUMN_WIDTH,
  initialWidths,
  keepWidths,
  MAX_AUTO_WIDTH,
  MIN_COLUMN_WIDTH,
  resizedWidths,
  SAMPLE_ROWS,
} from '../../../../../webview/src/apps/result-grid/columns';

const columns = [{ name: 'id' }, { name: 'email' }];

describe('initialWidths', () => {
  it('gives one width per column', () => {
    expect(initialWidths(columns)).toHaveLength(2);
  });

  it('makes a column with a long header wider', () => {
    const [short, long] = initialWidths([{ name: 'id' }, { name: 'a_very_long_column_name' }]);
    expect(long).toBeGreaterThan(short ?? 0);
  });

  it('widens a column to fit its values', () => {
    const rows: CellValue[][] = [
      [1, 'alice@example.com'],
      [2, 'bob@example.com'],
    ];
    const [idWidth, emailWidth] = initialWidths(columns, rows);
    expect(emailWidth).toBeGreaterThan(idWidth ?? 0);
  });

  it('never goes below the minimum or above the automatic maximum', () => {
    const narrow = initialWidths([{ name: '' }]);
    expect(narrow[0]).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
    const wide = initialWidths([{ name: 'x' }], [['y'.repeat(5000)]]);
    expect(wide[0]).toBeLessThanOrEqual(MAX_AUTO_WIDTH);
  });

  it('keeps a column of only NULLs at the minimum width', () => {
    // The NULL label is short, so such a column never steals room from the rest.
    expect(initialWidths([{ name: 'x' }], [[null], [null]])).toEqual([MIN_COLUMN_WIDTH]);
  });

  it('measures only the first line of a multi-line value', () => {
    const short = initialWidths([{ name: 'x' }], [['one\n' + 'y'.repeat(200)]]);
    const long = initialWidths([{ name: 'x' }], [['y'.repeat(200)]]);
    expect(short[0]).toBeLessThan(long[0] ?? 0);
  });

  it('looks at a sample of rows, not all of them', () => {
    const rows: CellValue[][] = Array.from({ length: SAMPLE_ROWS + 10 }, (_, index) => [
      index < SAMPLE_ROWS ? 'short' : 'a much longer value that would widen the column',
    ]);
    const sampled = initialWidths([{ name: 'x' }], rows);
    const everything = initialWidths([{ name: 'x' }], rows.slice(SAMPLE_ROWS));
    expect(sampled[0]).toBeLessThan(everything[0] ?? 0);
  });

  it('copes with rows that have not arrived yet', () => {
    const widths = initialWidths(columns, [undefined, [1, 'a@b.c']]);
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
  });

  it('has nothing to measure without columns', () => {
    expect(initialWidths([])).toEqual([]);
  });
});

describe('resizedWidths', () => {
  it('widens and narrows the dragged column only', () => {
    expect(resizedWidths([100, 200], 0, 50)).toEqual([150, 200]);
    expect(resizedWidths([100, 200], 1, -50)).toEqual([100, 150]);
  });

  it('stops at the minimum width', () => {
    expect(resizedWidths([100], 0, -1000)).toEqual([MIN_COLUMN_WIDTH]);
  });

  it('allows a column wider than the automatic maximum', () => {
    expect(resizedWidths([100], 0, 1000)[0]).toBe(1100);
  });

  it('rounds to whole pixels', () => {
    expect(resizedWidths([100], 0, 10.4)).toEqual([110]);
  });

  it('ignores an index that is not there', () => {
    expect(resizedWidths([100], 5, 10)).toEqual([100]);
    expect(resizedWidths([100], -1, 10)).toEqual([100]);
  });
});

describe('keepWidths', () => {
  it('keeps the widths the user already set', () => {
    expect(keepWidths([300], columns)).toEqual([300, expect.any(Number)]);
  });

  it('measures the columns that are new', () => {
    const widths = keepWidths([300], [{ name: 'id' }, { name: 'a_long_header_here' }]);
    expect(widths[0]).toBe(300);
    expect(widths[1]).toBeGreaterThan(MIN_COLUMN_WIDTH);
  });

  it('drops widths of columns that are gone', () => {
    expect(keepWidths([300, 400, 500], [{ name: 'id' }])).toEqual([300]);
  });
});

describe('clamp', () => {
  it('keeps a value inside the range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(0, 1, 10)).toBe(1);
    expect(clamp(50, 1, 10)).toBe(10);
  });
});

describe('DEFAULT_COLUMN_WIDTH', () => {
  it('sits between the bounds', () => {
    expect(DEFAULT_COLUMN_WIDTH).toBeGreaterThan(MIN_COLUMN_WIDTH);
    expect(DEFAULT_COLUMN_WIDTH).toBeLessThan(MAX_AUTO_WIDTH);
  });
});

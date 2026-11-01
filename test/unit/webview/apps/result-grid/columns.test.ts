import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import {
  capWidths,
  clamp,
  DEFAULT_COLUMN_WIDTH,
  FIT_ROWS,
  HEADER_ICONS_WIDTH,
  fitColumnWidth,
  initialWidths,
  keepWidths,
  MAX_AUTO_WIDTH,
  MAX_FIT_WIDTH,
  MIN_COLUMN_WIDTH,
  resizedWidths,
  SAMPLE_ROWS,
} from '../../../../../webview/src/apps/result-grid/columns';

const columns = [{ name: 'id' }, { name: 'email' }];

describe('NOT NULL columns', () => {
  it('make room for the mark after the name', () => {
    const header = [{ name: 'a_rather_long_column_name' }];
    const [plain] = initialWidths(header);
    const [marked] = initialWidths(header, [], [true]);
    expect(marked).toBeGreaterThan(plain ?? 0);
    expect(initialWidths(header, [], [false])).toEqual([plain]);
  });

  it('count the mark when fitting to the content too', () => {
    const column = { name: 'a_rather_long_column_name' };
    expect(fitColumnWidth(column, 0, [], true)).toBeGreaterThan(fitColumnWidth(column, 0, []));
  });
});

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

  it('keeps a column of only NULLs as narrow as its header', () => {
    // The NULL label is short, so such a column never steals room from the rest.
    expect(initialWidths([{ name: 'x' }], [[null], [null]])).toEqual(
      initialWidths([{ name: 'x' }]),
    );
  });

  it('leaves room in the header for the type icon and the sort arrow', () => {
    // 'id' and its values need little, but the header shows two icons besides the name.
    const [width] = initialWidths([{ name: 'id' }], [[1], [2]]);
    expect(width).toBeGreaterThanOrEqual(Math.round(2 * 7.2 + 18 + HEADER_ICONS_WIDTH));
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

describe('fitColumnWidth', () => {
  const column = { name: 'note' };

  it('fits the longest value in the rows, beyond the automatic maximum', () => {
    const narrow = fitColumnWidth(column, 0, [['short']]);
    const wide = fitColumnWidth(column, 0, [['x'.repeat(100)]]);
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeGreaterThan(MAX_AUTO_WIDTH);
  });

  it('stops at the widest a fit goes', () => {
    expect(fitColumnWidth(column, 0, [['x'.repeat(5000)]])).toBe(MAX_FIT_WIDTH);
  });

  it('is never narrower than the header or the minimum', () => {
    expect(fitColumnWidth({ name: 'a_rather_long_header' }, 0, [['x']])).toBeGreaterThan(
      MIN_COLUMN_WIDTH,
    );
    expect(fitColumnWidth({ name: '' }, 0, [])).toBe(26 + HEADER_ICONS_WIDTH);
  });

  it('measures the column it is asked about and only its first line', () => {
    const rows = [['x'.repeat(300), 'tiny\n' + 'y'.repeat(500)]];
    expect(fitColumnWidth(column, 1, rows)).toBe(fitColumnWidth(column, 1, [['', 'tiny']]));
  });

  it('copes with rows that have not arrived and with short rows', () => {
    expect(fitColumnWidth(column, 3, [undefined, ['a']])).toBe(fitColumnWidth(column, 3, []));
  });

  it('looks at no more rows than a fit is allowed to', () => {
    const rows = Array.from({ length: FIT_ROWS + 10 }, (_, i) => [
      i < FIT_ROWS ? 'a' : 'z'.repeat(80),
    ]);
    expect(fitColumnWidth(column, 0, rows)).toBe(fitColumnWidth(column, 0, [['a']]));
  });
});

describe("the user's limit on column width (V13.3)", () => {
  const columns = [{ name: 'note' }, { name: 'id' }];
  const rows = [['x'.repeat(150), '1']];

  it('keeps the old maximum when no limit is given', () => {
    expect(initialWidths(columns, rows)[0]).toBe(MAX_AUTO_WIDTH);
  });

  it('cuts an automatic width at a narrower limit and leaves a short column alone', () => {
    const widths = initialWidths(columns, rows, [], 240);
    expect(widths[0]).toBe(240);
    expect(widths[1]).toBe(initialWidths(columns, rows)[1]);
  });

  it('lets an automatic width grow up to a wider limit', () => {
    const wide = initialWidths(columns, [['x'.repeat(190), '1']], [], 1600)[0] ?? 0;
    expect(wide).toBeGreaterThan(MAX_AUTO_WIDTH);
    expect(wide).toBeLessThanOrEqual(1600);
  });

  it('never goes below the narrowest a column can be', () => {
    expect(initialWidths([{ name: '' }], [], [], 10)[0]).toBe(MIN_COLUMN_WIDTH);
  });

  it('applies to keepWidths for a new set of columns, but keeps what was sized', () => {
    expect(keepWidths([], columns, rows, 240)[0]).toBe(240);
    expect(keepWidths([500], columns, rows, 240)[0]).toBe(500);
  });

  it('lets "fit to content" go past a narrow limit: it was asked for', () => {
    expect(fitColumnWidth(columns[0] ?? { name: '' }, 0, [['x'.repeat(100)]], false, 240)).toBe(
      fitColumnWidth(columns[0] ?? { name: '' }, 0, [['x'.repeat(100)]]),
    );
  });

  it('lets "fit to content" reach a limit larger than its own maximum', () => {
    const fit = fitColumnWidth({ name: 'note' }, 0, [['x'.repeat(300)]], false, 1600);
    expect(fit).toBeGreaterThan(MAX_FIT_WIDTH);
    expect(fit).toBeLessThanOrEqual(1600);
  });
});

describe('capWidths', () => {
  it('cuts only the widths over the limit', () => {
    expect(capWidths([100, 300, 900], 300)).toEqual([100, 300, 300]);
  });

  it('keeps at least the narrowest width and does not touch the input', () => {
    const input = [60, 500];
    expect(capWidths(input, 10)).toEqual([MIN_COLUMN_WIDTH, MIN_COLUMN_WIDTH]);
    expect(input).toEqual([60, 500]);
  });

  it('copes with no columns', () => {
    expect(capWidths([], 300)).toEqual([]);
  });
});

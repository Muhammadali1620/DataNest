import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE } from '../../../../../src/shared/protocols/result-grid';
import {
  columnGeometry,
  columnLayout,
  rangeOf,
  rowGeometry,
  ROW_OVERSCAN,
  rowTop,
} from '../../../../../webview/src/apps/result-grid/virtual';

describe('rowGeometry', () => {
  it('renders the viewport plus the overscan at the top', () => {
    const geometry = rowGeometry(0, 400, 20, 1000);
    expect(geometry.firstIndex).toBe(0);
    // 400 / 20 = 20 visible, plus one partial row, plus the overscan.
    expect(geometry.lastIndex).toBe(20 + 1 + ROW_OVERSCAN);
    expect(geometry.topPadding).toBe(0);
    expect(geometry.totalHeight).toBe(20_000);
  });

  it('moves the window as the user scrolls', () => {
    const geometry = rowGeometry(1000, 400, 20, 1000);
    expect(geometry.firstIndex).toBe(50 - ROW_OVERSCAN);
    expect(geometry.topPadding).toBe((50 - ROW_OVERSCAN) * 20);
    expect(geometry.lastIndex).toBeGreaterThan(50);
  });

  it('keeps the padding aligned with the first rendered row', () => {
    for (const scrollTop of [0, 37, 500, 9999]) {
      const geometry = rowGeometry(scrollTop, 300, 24, 500);
      expect(geometry.topPadding).toBe(geometry.firstIndex * 24);
    }
  });

  it('stops at the last row', () => {
    const geometry = rowGeometry(100_000, 400, 20, 100);
    expect(geometry.lastIndex).toBe(99);
    expect(geometry.firstIndex).toBeLessThanOrEqual(99);
  });

  it('renders every row of a short result', () => {
    const geometry = rowGeometry(0, 400, 20, 3);
    expect(geometry.firstIndex).toBe(0);
    expect(geometry.lastIndex).toBe(2);
    expect(geometry.totalHeight).toBe(60);
  });

  it('has nothing to render for an empty result', () => {
    expect(rowGeometry(0, 400, 20, 0)).toEqual({
      firstIndex: 0,
      lastIndex: -1,
      topPadding: 0,
      totalHeight: 0,
    });
  });

  it('has nothing to render before the viewport is measured', () => {
    expect(rowGeometry(0, 0, 20, 100).lastIndex).toBe(-1);
  });

  it('survives nonsense input', () => {
    expect(rowGeometry(-100, 400, 20, 100).firstIndex).toBe(0);
    expect(rowGeometry(0, 400, 0, 10).totalHeight).toBe(10);
    expect(rowGeometry(0, 400, 20, -5).totalHeight).toBe(0);
  });

  it('covers a million rows without touching them', () => {
    const geometry = rowGeometry(10_000_000, 600, 22, 1_000_000);
    expect(geometry.lastIndex - geometry.firstIndex).toBeLessThan(60);
    expect(geometry.totalHeight).toBe(22_000_000);
  });
});

describe('columnLayout', () => {
  it('turns widths into left edges and a total', () => {
    expect(columnLayout([100, 50, 200])).toEqual({
      offsets: [0, 100, 150, 350],
      totalWidth: 350,
    });
  });

  it('handles no columns', () => {
    expect(columnLayout([])).toEqual({ offsets: [0], totalWidth: 0 });
  });

  it('treats a negative width as zero', () => {
    expect(columnLayout([-10, 20]).totalWidth).toBe(20);
  });
});

describe('columnGeometry', () => {
  const layout = columnLayout(Array.from({ length: 100 }, () => 100));

  it('renders the columns inside the viewport plus the overscan', () => {
    const geometry = columnGeometry(0, 450, layout, 1);
    expect(geometry.firstIndex).toBe(0);
    // Columns 0..4 touch the viewport; one more is kept on the right.
    expect(geometry.lastIndex).toBe(5);
    expect(geometry.leftPadding).toBe(0);
    expect(geometry.totalWidth).toBe(10_000);
  });

  it('moves the window as the user scrolls sideways', () => {
    const geometry = columnGeometry(1000, 300, layout, 1);
    expect(geometry.firstIndex).toBe(9);
    expect(geometry.leftPadding).toBe(900);
    expect(geometry.lastIndex).toBe(13);
  });

  it('keeps the padding aligned with the first rendered column', () => {
    const uneven = columnLayout([80, 300, 40, 500, 120]);
    for (const scrollLeft of [0, 100, 400, 900]) {
      const geometry = columnGeometry(scrollLeft, 300, uneven, 0);
      expect(geometry.leftPadding).toBe(uneven.offsets[geometry.firstIndex]);
    }
  });

  it('includes a column that is only partly visible', () => {
    const geometry = columnGeometry(150, 100, columnLayout([100, 100, 100]), 0);
    expect(geometry.firstIndex).toBe(1);
    expect(geometry.lastIndex).toBe(2);
  });

  it('stops at the last column', () => {
    const geometry = columnGeometry(99_999, 300, layout, 2);
    expect(geometry.lastIndex).toBe(99);
  });

  it('has nothing to render without columns or before measuring', () => {
    expect(columnGeometry(0, 300, columnLayout([])).lastIndex).toBe(-1);
    expect(columnGeometry(0, 0, layout).lastIndex).toBe(-1);
  });

  it('renders every column when they all fit', () => {
    const geometry = columnGeometry(0, 1000, columnLayout([100, 100, 100]), 0);
    expect(geometry.firstIndex).toBe(0);
    expect(geometry.lastIndex).toBe(2);
  });
});

describe('rangeOf', () => {
  it('lists the indexes inclusively', () => {
    expect(rangeOf(2, 5)).toEqual([2, 3, 4, 5]);
    expect(rangeOf(0, 0)).toEqual([0]);
  });

  it('is empty when there is nothing to render', () => {
    expect(rangeOf(0, -1)).toEqual([]);
    expect(rangeOf(5, 2)).toEqual([]);
  });
});

describe('the largest result', () => {
  // Chromium cannot make an element taller than this many pixels; a scrollbar past it
  // would stop short of the last rows.
  const CHROMIUM_MAX_HEIGHT = 33_554_428;

  it('fits in one scrollable element at the grid row height', () => {
    // A table view holds at most MAX_PAGE_SIZE rows, and so does the row limit setting;
    // a few thousand new rows waiting to be inserted come on top.
    const geometry = rowGeometry(0, 600, 22, MAX_PAGE_SIZE + 10_000);
    expect(geometry.totalHeight).toBeLessThan(CHROMIUM_MAX_HEIGHT);
  });

  it('renders only a screenful of rows anywhere in it', () => {
    for (const scrollTop of [0, 11_000_000, 22_000_000]) {
      const geometry = rowGeometry(scrollTop, 600, 22, MAX_PAGE_SIZE);
      expect(geometry.lastIndex - geometry.firstIndex + 1).toBeLessThanOrEqual(50);
    }
  });
});

describe('rows with one row open', () => {
  const gap = { row: 5, extra: 100 };

  it('moves the rows after the open one down by its room, and none before it', () => {
    expect(rowTop(5, 20, gap)).toBe(100);
    expect(rowTop(6, 20, gap)).toBe(120 + 100);
    expect(rowTop(2, 20, gap)).toBe(40);
    expect(rowTop(6, 20)).toBe(120);
  });

  it('makes the whole result taller by the room', () => {
    expect(rowGeometry(0, 400, 20, 1000, ROW_OVERSCAN, gap).totalHeight).toBe(20_100);
  });

  it('is the plain geometry when nothing is open or the open row does not exist', () => {
    const plain = rowGeometry(300, 400, 20, 1000);
    expect(rowGeometry(300, 400, 20, 1000, ROW_OVERSCAN, undefined)).toEqual(plain);
    expect(rowGeometry(300, 400, 20, 1000, ROW_OVERSCAN, { row: 5000, extra: 100 })).toEqual(plain);
    expect(rowGeometry(300, 400, 20, 1000, ROW_OVERSCAN, { row: -1, extra: 100 })).toEqual(plain);
    expect(rowGeometry(300, 400, 20, 1000, ROW_OVERSCAN, { row: 3, extra: 0 })).toEqual(plain);
  });

  it('renders the rows that are really on screen below the open one', () => {
    // Scrolled 1000 px down: the rows after the open one start 100 px later than usual.
    const geometry = rowGeometry(1000, 400, 20, 1000, 0, gap);
    expect(geometry.firstIndex).toBe(45);
    expect(rowTop(geometry.firstIndex, 20, gap)).toBe(geometry.topPadding);
    expect(geometry.lastIndex).toBeGreaterThan(geometry.firstIndex + 18);
  });

  it('keeps the open row rendered while its details are on screen', () => {
    // Row 5 ends at 120 px; its room runs to 220 px. Scrolled to 150 px, row 5 is still the one.
    const geometry = rowGeometry(150, 200, 20, 1000, 0, gap);
    expect(geometry.firstIndex).toBe(5);
  });

  it('works for the last row', () => {
    const last = { row: 9, extra: 60 };
    const geometry = rowGeometry(10_000, 100, 20, 10, 0, last);
    expect(geometry.lastIndex).toBe(9);
    expect(geometry.totalHeight).toBe(260);
  });
});

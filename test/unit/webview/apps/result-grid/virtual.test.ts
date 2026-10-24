import { describe, expect, it } from 'vitest';
import {
  columnGeometry,
  columnLayout,
  rangeOf,
  rowGeometry,
  ROW_OVERSCAN,
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

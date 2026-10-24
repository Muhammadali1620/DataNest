// The arithmetic of a virtualized grid: which rows and columns are on screen and
// where they sit. Free of the DOM, so every edge case is a unit test.

export interface RowGeometry {
  /** First row to render. */
  readonly firstIndex: number;
  /** Last row to render, inclusive; -1 when there is nothing to show. */
  readonly lastIndex: number;
  /** Pixels of empty space above the first rendered row. */
  readonly topPadding: number;
  /** Height of the whole result, so the scrollbar is the right size. */
  readonly totalHeight: number;
}

/** Rows kept above and below the viewport, so scrolling does not flash. */
export const ROW_OVERSCAN = 8;

export function rowGeometry(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = ROW_OVERSCAN,
): RowGeometry {
  const height = Math.max(1, rowHeight);
  const total = Math.max(0, Math.trunc(rowCount));
  const totalHeight = total * height;
  if (total === 0 || viewportHeight <= 0) {
    return { firstIndex: 0, lastIndex: -1, topPadding: 0, totalHeight };
  }
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)));
  const firstVisible = Math.floor(top / height);
  const visibleCount = Math.ceil(viewportHeight / height) + 1;
  const firstIndex = Math.max(0, firstVisible - overscan);
  const lastIndex = Math.min(total - 1, firstVisible + visibleCount + overscan);
  return { firstIndex, lastIndex, topPadding: firstIndex * height, totalHeight };
}

export interface ColumnLayout {
  /** Left edge of every column, plus the total width as the last entry. */
  readonly offsets: readonly number[];
  readonly totalWidth: number;
}

/** Left edges of columns of the given widths. */
export function columnLayout(widths: readonly number[]): ColumnLayout {
  const offsets: number[] = [0];
  let running = 0;
  for (const width of widths) {
    running += Math.max(0, width);
    offsets.push(running);
  }
  return { offsets, totalWidth: running };
}

export interface ColumnGeometry {
  readonly firstIndex: number;
  /** Inclusive; -1 when there are no columns. */
  readonly lastIndex: number;
  /** Pixels of empty space left of the first rendered column. */
  readonly leftPadding: number;
  readonly totalWidth: number;
}

/** Columns kept left and right of the viewport. */
export const COLUMN_OVERSCAN = 2;

export function columnGeometry(
  scrollLeft: number,
  viewportWidth: number,
  layout: ColumnLayout,
  overscan = COLUMN_OVERSCAN,
): ColumnGeometry {
  const count = layout.offsets.length - 1;
  if (count <= 0 || viewportWidth <= 0) {
    return { firstIndex: 0, lastIndex: -1, leftPadding: 0, totalWidth: layout.totalWidth };
  }
  const left = Math.max(0, Math.min(scrollLeft, Math.max(0, layout.totalWidth - viewportWidth)));
  const right = left + viewportWidth;
  let first = count - 1;
  let last = 0;
  for (let index = 0; index < count; index++) {
    const start = layout.offsets[index] ?? 0;
    const end = layout.offsets[index + 1] ?? start;
    // A column counts as visible when any part of it is inside the viewport.
    if (end > left && start < right) {
      first = Math.min(first, index);
      last = Math.max(last, index);
    }
  }
  const firstIndex = Math.max(0, first - overscan);
  const lastIndex = Math.min(count - 1, last + overscan);
  return {
    firstIndex,
    lastIndex,
    leftPadding: layout.offsets[firstIndex] ?? 0,
    totalWidth: layout.totalWidth,
  };
}

/** Indexes from `first` to `last` inclusive; empty when `last` is before `first`. */
export function rangeOf(first: number, last: number): number[] {
  if (last < first) {
    return [];
  }
  const out: number[] = [];
  for (let index = first; index <= last; index++) {
    out.push(index);
  }
  return out;
}

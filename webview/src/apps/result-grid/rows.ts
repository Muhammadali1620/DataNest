// Keeping the visible rows in the page: which window to ask the host for, and a
// sparse store of what has arrived. Free of Svelte so the logic is tested directly.

import type { CellValue } from '../../../../src/shared/cell-value';
import { MAX_WINDOW_ROWS, WINDOW_OVERSCAN } from '../../../../src/shared/protocols/result-grid';

/** A cell with a pending change, as the host reports it. */
export interface ChangeMark {
  readonly row: number;
  readonly column: number;
  readonly kind: 'value' | 'default';
}

export interface RowRange {
  readonly offset: number;
  readonly limit: number;
}

/**
 * The range to fetch for a visible span: a little above and below, clamped to the
 * result and to what one request may carry.
 */
export function windowFor(
  firstVisible: number,
  visibleCount: number,
  rowCount: number,
  overscan = WINDOW_OVERSCAN,
): RowRange | undefined {
  if (rowCount <= 0 || visibleCount <= 0) {
    return undefined;
  }
  const first = Math.max(0, Math.min(Math.trunc(firstVisible), rowCount - 1));
  const offset = Math.max(0, first - overscan);
  const end = Math.min(rowCount, first + Math.trunc(visibleCount) + overscan);
  const limit = Math.min(MAX_WINDOW_ROWS, Math.max(1, end - offset));
  return { offset, limit };
}

/** A sparse set of rows, filled by windows as they arrive. */
export class RowCache {
  private rows = new Map<number, readonly CellValue[]>();
  /** Pending changes of cells, keyed `row:column`. */
  private marks = new Map<string, 'value' | 'default'>();
  private total = 0;

  get rowCount(): number {
    return this.total;
  }

  get loadedCount(): number {
    return this.rows.size;
  }

  /** Replaces everything; used when the tab changes or a new result arrives. */
  reset(rowCount = 0): void {
    this.rows = new Map();
    this.marks = new Map();
    this.total = Math.max(0, Math.trunc(rowCount));
  }

  /** Stores a window; a reported row count that shrank drops the rows past it. */
  put(
    offset: number,
    rows: readonly (readonly CellValue[])[],
    rowCount: number,
    changes: readonly ChangeMark[] = [],
  ): void {
    const total = Math.max(0, Math.trunc(rowCount));
    if (total !== this.total) {
      this.total = total;
      for (const index of [...this.rows.keys()]) {
        if (index >= total) {
          this.rows.delete(index);
        }
      }
      for (const key of [...this.marks.keys()]) {
        if (Number(key.split(':')[0]) >= total) {
          this.marks.delete(key);
        }
      }
    }
    // The window is the truth for its rows, so marks of an edit that was undone go.
    for (const key of [...this.marks.keys()]) {
      const row = Number(key.split(':')[0]);
      if (row >= offset && row < offset + rows.length) {
        this.marks.delete(key);
      }
    }
    for (const change of changes) {
      this.marks.set(`${change.row}:${change.column}`, change.kind);
    }
    for (const [position, row] of rows.entries()) {
      const index = offset + position;
      if (index < this.total) {
        this.rows.set(index, row);
      }
    }
  }

  /** How a cell was changed and not yet saved, if it was. */
  changeAt(row: number, column: number): 'value' | 'default' | undefined {
    return this.marks.get(`${row}:${column}`);
  }

  get(index: number): readonly CellValue[] | undefined {
    return this.rows.get(index);
  }

  has(index: number): boolean {
    return this.rows.has(index);
  }

  /** True when every row of a range is already here, so no request is needed. */
  hasRange(offset: number, limit: number): boolean {
    const end = Math.min(this.total, offset + limit);
    for (let index = Math.max(0, offset); index < end; index++) {
      if (!this.rows.has(index)) {
        return false;
      }
    }
    return true;
  }
}

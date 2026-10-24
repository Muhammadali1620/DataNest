// Column widths: a sensible first guess from the header and the first rows, and
// what a drag on the separator does to them.

import { cellText } from '../../../../src/shared/cell-text';
import type { CellValue } from '../../../../src/shared/cell-value';
import type { ResultColumnInfo } from '../../../../src/shared/protocols/result-grid';

/** Narrowest a column may get by dragging. */
export const MIN_COLUMN_WIDTH = 48;

/** Widest a column gets on its own; dragging may make it wider. */
export const MAX_AUTO_WIDTH = 420;

/** Width when there is nothing to measure. */
export const DEFAULT_COLUMN_WIDTH = 140;

/** Width of the row-number column. */
export const ROW_NUMBER_WIDTH = 56;

/** Pixels per character, close enough for the editor's monospace font. */
const CHAR_WIDTH = 7.2;

/** Padding and the cell border. */
const CELL_PADDING = 18;

/** How many rows are measured for the first guess. */
export const SAMPLE_ROWS = 50;

/**
 * A first width per column, from the header text and the first rows. Measuring
 * every row of a large result would cost more than it is worth, so only a sample
 * is used; the user can always drag.
 */
export function initialWidths(
  columns: readonly ResultColumnInfo[],
  rows: readonly (readonly CellValue[] | undefined)[] = [],
): number[] {
  const sample = rows.slice(0, SAMPLE_ROWS);
  return columns.map((column, index) => {
    let longest = column.name.length;
    for (const row of sample) {
      const value = row?.[index];
      if (value !== undefined) {
        // Only the first line matters: a cell shows one line.
        const text = cellText(value, { nullText: 'NULL' });
        const firstLine = text.split('\n', 1)[0] ?? '';
        longest = Math.max(longest, Math.min(firstLine.length, 200));
      }
    }
    const width = Math.round(longest * CHAR_WIDTH + CELL_PADDING);
    return clamp(width, MIN_COLUMN_WIDTH, MAX_AUTO_WIDTH);
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Widths after dragging the separator of one column by `delta` pixels. */
export function resizedWidths(widths: readonly number[], index: number, delta: number): number[] {
  if (index < 0 || index >= widths.length) {
    return [...widths];
  }
  const next = [...widths];
  const current = next[index] ?? DEFAULT_COLUMN_WIDTH;
  // No upper bound: a user who drags wide means it.
  next[index] = Math.max(MIN_COLUMN_WIDTH, Math.round(current + delta));
  return next;
}

/** Widths for a new set of columns, keeping those the user already sized. */
export function keepWidths(
  previous: readonly number[],
  columns: readonly ResultColumnInfo[],
  rows: readonly (readonly CellValue[] | undefined)[] = [],
): number[] {
  const fresh = initialWidths(columns, rows);
  return fresh.map((width, index) => previous[index] ?? width);
}

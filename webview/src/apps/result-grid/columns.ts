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
const CHAR_WIDTH = 8.4;

/** Padding and the cell border. */
const CELL_PADDING = 26;

/** The header's type icon, and room for the sort arrow, beside the column name. */
export const HEADER_ICONS_WIDTH = 96;

/** How many rows are measured for the first guess. */
export const SAMPLE_ROWS = 50;

/** Widest "fit to content" goes; a longer value is cut by the cell anyway. */
export const MAX_FIT_WIDTH = 800;

/** Rows measured by "fit to content", which is an explicit request and may look further. */
export const FIT_ROWS = 500;

/** Pixel width a header and the given rows need, measured by their longest first line. */
function measure(
  name: string,
  index: number,
  rows: readonly (readonly CellValue[] | undefined)[],
  maxChars: number,
  maxWidth: number,
): number {
  let longest = 0;
  for (const row of rows) {
    const value = row?.[index];
    if (value !== undefined) {
      // Only the first line matters: a cell shows one line.
      const text = cellText(value, { nullText: 'NULL' });
      const firstLine = text.split('\n', 1)[0] ?? '';
      longest = Math.max(longest, Math.min(firstLine.length, maxChars));
    }
  }
  const header = name.length * CHAR_WIDTH + CELL_PADDING + HEADER_ICONS_WIDTH;
  const content = longest * CHAR_WIDTH + CELL_PADDING;
  return clamp(Math.round(Math.max(header, content)), MIN_COLUMN_WIDTH, maxWidth);
}

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
  return columns.map((column, index) => measure(column.name, index, sample, 200, MAX_AUTO_WIDTH));
}

/**
 * The width that shows a column's longest value in the rows given, up to
 * `MAX_FIT_WIDTH`: what "fit to content" does on request.
 */
export function fitColumnWidth(
  column: ResultColumnInfo,
  index: number,
  rows: readonly (readonly CellValue[] | undefined)[],
): number {
  return measure(column.name, index, rows.slice(0, FIT_ROWS), 400, MAX_FIT_WIDTH);
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

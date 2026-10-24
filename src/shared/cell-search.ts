// Quick search over a result: which rows contain the text. Runs in the host over
// every row, so a match far below the visible window is still found.

import { cellText } from './cell-text';
import type { CellValue } from './cell-value';

/** True when the value's text contains `needle`, ignoring case. */
export function cellMatches(value: CellValue, needle: string): boolean {
  if (needle === '') {
    return false;
  }
  // NULL is searchable by its label, which is what the user sees in the cell.
  const text = cellText(value, { nullText: 'NULL' });
  return text.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

export interface SearchHits {
  /** Indexes of matching rows, in order, capped at the requested limit. */
  readonly rows: number[];
  /** How many rows match in total, even when more than the cap. */
  readonly total: number;
}

/** Rows that contain the text in any column. */
export function findRows(
  rows: readonly (readonly CellValue[])[],
  needle: string,
  limit = 1000,
): SearchHits {
  if (needle.trim() === '') {
    return { rows: [], total: 0 };
  }
  const found: number[] = [];
  let total = 0;
  for (const [index, row] of rows.entries()) {
    if (row.some((value) => cellMatches(value, needle))) {
      total += 1;
      if (found.length < limit) {
        found.push(index);
      }
    }
  }
  return { rows: found, total };
}

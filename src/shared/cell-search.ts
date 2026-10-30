// Quick search over a result: which rows contain the text. Runs in the host over
// every row, so a match far below the visible window is still found.

import { cellText } from './cell-text';
import type { CellValue } from './cell-value';
import { type PauseOptions, runSteps, runStepsPaused } from './merge-sort';

/** True when the value's text contains `needle`, ignoring case. */
export function cellMatches(value: CellValue, needle: string): boolean {
  if (needle === '') {
    return false;
  }
  return containsLowered(value, needle.toLocaleLowerCase());
}

const SEARCH_TEXT = { nullText: 'NULL' } as const;

/** `cellMatches` with the needle already lowered, so a search lowers it once, not per cell. */
function containsLowered(value: CellValue, lowered: string): boolean {
  // NULL is searchable by its label, which is what the user sees in the cell.
  return cellText(value, SEARCH_TEXT).toLocaleLowerCase().includes(lowered);
}

export interface SearchHits {
  /** Indexes of matching rows, in order, capped at the requested limit. */
  readonly rows: number[];
  /** How many rows match in total, even when more than the cap. */
  readonly total: number;
}

/** Rows looked at between two yields. */
const SEARCH_STEP = 2048;

function* searchSteps(
  rows: readonly (readonly CellValue[])[],
  needle: string,
  limit: number,
): Generator<void, SearchHits, void> {
  if (needle.trim() === '') {
    return { rows: [], total: 0 };
  }
  const lowered = needle.toLocaleLowerCase();
  const found: number[] = [];
  let total = 0;
  for (let index = 0; index < rows.length; index++) {
    if ((rows[index] ?? []).some((value) => containsLowered(value, lowered))) {
      total += 1;
      if (found.length < limit) {
        found.push(index);
      }
    }
    if (index % SEARCH_STEP === SEARCH_STEP - 1) {
      yield;
    }
  }
  return { rows: found, total };
}

/** Rows that contain the text in any column. */
export function findRows(
  rows: readonly (readonly CellValue[])[],
  needle: string,
  limit = 1000,
): SearchHits {
  return runSteps(searchSteps(rows, needle, limit));
}

/**
 * The same search in slices with pauses between them, so a million rows do not hold
 * the thread; `stale` is asked at every pause and ends the search early (undefined)
 * once a newer one has made it pointless.
 */
export async function findRowsPaused(
  rows: readonly (readonly CellValue[])[],
  needle: string,
  limit = 1000,
  options: PauseOptions & { readonly stale?: () => boolean } = {},
): Promise<SearchHits | undefined> {
  const { stale, ...pause } = options;
  const steps = searchSteps(rows, needle, limit);
  const guarded = (function* (): Generator<void, SearchHits | undefined, void> {
    for (;;) {
      const next = steps.next();
      if (next.done === true) {
        return next.value;
      }
      if (stale?.() === true) {
        return undefined;
      }
      yield;
    }
  })();
  return runStepsPaused(guarded, pause);
}

// "Filter…" on the Tables and Views folders of the tree (V10.2.3): what the user types
// narrows the list for this session. Free of `vscode`, so the rules are unit-tested.

import { nameFilter, parsePatterns } from '../../shared/name-filter';

/** Longest filter text kept; longer input is cut, it is a search box, not a document. */
export const MAX_TABLE_FILTER_LENGTH = 200;

/**
 * Plain words find names that contain them (`order` → `orders`, `customer_orders`);
 * with `*`, `?` or `!` the text is patterns, as in the database filter (`app_*, !tmp`).
 */
export function tableFilter(text: string): (name: string) => boolean {
  const patterns = parsePatterns(text.slice(0, MAX_TABLE_FILTER_LENGTH)).map((pattern) =>
    /[*?!]/u.test(pattern) ? pattern : `*${pattern}*`,
  );
  return nameFilter(patterns);
}

/** The text to keep: trimmed and cut; empty means no filter. */
export function normalizeTableFilter(text: string): string | undefined {
  const trimmed = text.trim().slice(0, MAX_TABLE_FILTER_LENGTH);
  return trimmed === '' || parsePatterns(trimmed).length === 0 ? undefined : trimmed;
}

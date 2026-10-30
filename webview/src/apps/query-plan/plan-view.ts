// What the query plan page (V8.2) needs besides drawing: which rows a collapsed tree
// shows, and numbers, times and rows as short text.

import type { QueryPlanRow } from '../../../../src/shared/protocols/query-plan';

/** Indexes of the rows to show when the rows at `collapsed` hide what is under them. */
export function visibleRows(
  rows: readonly QueryPlanRow[],
  collapsed: ReadonlySet<number>,
): number[] {
  const shown: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    shown.push(index);
    if (collapsed.has(index)) {
      index += rows[index]?.descendants ?? 0;
    }
  }
  return shown;
}

/** The row above in the tree, or undefined at the top. */
export function parentOf(rows: readonly QueryPlanRow[], index: number): number | undefined {
  const depth = rows[index]?.depth ?? 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    if ((rows[at]?.depth ?? 0) < depth) {
      return at;
    }
  }
  return undefined;
}

export function formatNumber(value: number | undefined, locale?: string): string {
  if (value === undefined) {
    return '';
  }
  const digits =
    Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : Math.abs(value) >= 1 ? 2 : 4;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

export function formatMs(value: number | undefined, locale?: string): string {
  if (value === undefined) {
    return '';
  }
  if (value >= 1000) {
    return `${formatNumber(Math.round(value / 10) / 100, locale)} s`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 1 : 3 }).format(value)} ms`;
}

/** `1,450` or `1,450 → 12` once the statement ran. */
export function rowsText(row: QueryPlanRow, locale?: string): string {
  const estimated = formatNumber(row.rows, locale);
  if (row.actualRows === undefined) {
    return estimated;
  }
  const actual = formatNumber(row.actualRows, locale);
  return estimated === '' ? actual : `${estimated} → ${actual}`;
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// Comparing two query results (V12.4). The results are matched by the columns the user
// names as the key (or whole rows, when there is none), and only by the columns both
// have. What comes out is the counts and two listings with the rows in the same order,
// so the editor's own diff view can show what is different without a page of our own.
// Cells are equal when their exact values are (`10.50` and `10.5` are, `a` and `A` are
// not), the same rule as when comparing the rows of two tables (V8.4).

import { DbError } from '../core/errors';
import { msg } from '../core/user-message';
import type { CellValue } from '../shared/cell-value';
import { cellText } from '../shared/cell-text';
import { comparableText, keyOf } from './data-compare/comparable';

/** Rows kept to name the rows that differ; the counts are always exact. */
export const MAX_DIFFERING_ROWS = 1000;

export interface ComparedResult {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

export interface DifferingRow {
  /** The key values, as written in the listings. */
  readonly key: string;
  /** The columns whose values differ. */
  readonly columns: readonly string[];
}

export interface ResultComparison {
  /** Columns both results have, in the order of the first. */
  readonly columns: readonly string[];
  readonly onlyLeftColumns: readonly string[];
  readonly onlyRightColumns: readonly string[];
  /** The key; empty when whole rows were compared. */
  readonly key: readonly string[];
  readonly same: number;
  readonly different: number;
  readonly onlyLeft: number;
  readonly onlyRight: number;
  /** The first rows that differ, up to `MAX_DIFFERING_ROWS`. */
  readonly differing: readonly DifferingRow[];
  /** One line per row of the first result, then the second's, in matching order. */
  readonly leftText: string;
  readonly rightText: string;
}

/** A name as results compare names: `ID` and `id` are one column. */
function nameKey(name: string): string {
  return name.toLowerCase();
}

/** Where each name first appears; a repeated name (`id, id`) is its first column. */
function positions(columns: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const [index, name] of columns.entries()) {
    const key = nameKey(name);
    if (!found.has(key)) {
      found.set(key, index);
    }
  }
  return found;
}

/** The columns a pair of results share, with where each sits on either side. */
export function commonColumns(
  left: readonly string[],
  right: readonly string[],
): { name: string; left: number; right: number }[] {
  const rightAt = positions(right);
  const shared: { name: string; left: number; right: number }[] = [];
  for (const [name, leftAt] of positions(left)) {
    const at = rightAt.get(name);
    const written = left[leftAt];
    if (at !== undefined && written !== undefined) {
      shared.push({ name: written, left: leftAt, right: at });
    }
  }
  return shared;
}

/** One row on one line: tabs and line breaks inside values are written out. */
function rowLine(cells: readonly CellValue[]): string {
  return cells
    .map((cell) =>
      cellText(cell, { nullText: 'NULL' })
        .replaceAll('\\', '\\\\')
        .replaceAll('\t', '\\t')
        .replaceAll('\r', '\\r')
        .replaceAll('\n', '\\n'),
    )
    .join('\t');
}

interface Keyed {
  readonly id: string;
  /** What orders the row among the others. */
  readonly sortKey: string;
  readonly cells: readonly CellValue[];
}

/**
 * Rows with a key that tells the equal ones apart: a key (or a whole row) seen again is
 * counted, so two identical rows on one side match two on the other, and a third is extra.
 */
function keyRows(
  rows: readonly (readonly CellValue[])[],
  keyAt: readonly number[],
  cellsAt: readonly number[],
): Keyed[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = keyAt.map((at) => row[at] ?? null);
    const base = keyOf(key);
    const times = (seen.get(base) ?? 0) + 1;
    seen.set(base, times);
    return {
      id: `${base}#${times}`,
      sortKey: key.map((cell) => cellText(cell)).join('\u0001'),
      cells: cellsAt.map((at) => row[at] ?? null),
    };
  });
}

function order(a: Keyed, b: Keyed): number {
  return (
    a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true }) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Compares two results. `key` names the columns that identify a row (as the first
 * result spells them); none means whole rows are compared and none can be "different".
 */
export function compareResults(
  left: ComparedResult,
  right: ComparedResult,
  key: readonly string[] = [],
): ResultComparison {
  const shared = commonColumns(left.columns, right.columns);
  if (shared.length === 0) {
    throw new DbError('unsupported', msg('The two results have no column in common'));
  }
  const sharedNames = shared.map((column) => nameKey(column.name));
  const keyShared = key.map((name) => sharedNames.indexOf(nameKey(name)));
  const missing = key.filter((_, index) => keyShared[index] === -1);
  if (missing.length > 0) {
    throw new DbError(
      'unsupported',
      msg('Both results must have the key column: {0}', missing.join(', ')),
    );
  }
  const keyIndexes = key.length === 0 ? shared.map((_, index) => index) : keyShared;
  const leftRows = keyRows(
    left.rows,
    keyIndexes.map((index) => shared[index]?.left ?? 0),
    shared.map((column) => column.left),
  );
  const rightRows = keyRows(
    right.rows,
    keyIndexes.map((index) => shared[index]?.right ?? 0),
    shared.map((column) => column.right),
  );
  const rightById = new Map(rightRows.map((row) => [row.id, row]));
  const matched = new Set<string>();

  let same = 0;
  let different = 0;
  let onlyLeft = 0;
  const differing: DifferingRow[] = [];
  const leftLines: { row: Keyed; line: string }[] = [];
  const rightLines: { row: Keyed; line: string }[] = [];
  for (const row of leftRows) {
    const other = rightById.get(row.id);
    leftLines.push({ row, line: rowLine(row.cells) });
    if (other === undefined) {
      onlyLeft++;
      continue;
    }
    matched.add(row.id);
    rightLines.push({ row: other, line: rowLine(other.cells) });
    const changed = shared.filter(
      (_, index) =>
        comparableText(row.cells[index] ?? null) !== comparableText(other.cells[index] ?? null),
    );
    if (changed.length === 0) {
      same++;
      continue;
    }
    different++;
    if (differing.length < MAX_DIFFERING_ROWS) {
      differing.push({
        key: keyIndexes
          .map((index) => cellText(row.cells[index] ?? null, { nullText: 'NULL' }))
          .join(', '),
        columns: changed.map((column) => column.name),
      });
    }
  }
  let onlyRight = 0;
  for (const row of rightRows) {
    if (!matched.has(row.id)) {
      onlyRight++;
      rightLines.push({ row, line: rowLine(row.cells) });
    }
  }

  const listing = (lines: { row: Keyed; line: string }[]): string =>
    [
      rowLine(shared.map((column) => column.name)),
      ...lines.sort((a, b) => order(a.row, b.row)).map((entry) => entry.line),
    ].join('\n');
  const leftNames = new Set(sharedNames);
  const rightAt = new Set(right.columns.map(nameKey));
  return {
    columns: shared.map((column) => column.name),
    onlyLeftColumns: left.columns.filter((name) => !rightAt.has(nameKey(name))),
    onlyRightColumns: right.columns.filter((name) => !leftNames.has(nameKey(name))),
    key,
    same,
    different,
    onlyLeft,
    onlyRight,
    differing,
    leftText: listing(leftLines),
    rightText: listing(rightLines),
  };
}

/** The counts as one sentence for a notification. */
export function comparisonSummary(comparison: ResultComparison): string {
  if (comparison.different + comparison.onlyLeft + comparison.onlyRight === 0) {
    return msg('The results are the same: {0} rows', comparison.same);
  }
  return msg(
    '{0} rows are the same, {1} differ, {2} only in the first result, {3} only in the second',
    comparison.same,
    comparison.different,
    comparison.onlyLeft,
    comparison.onlyRight,
  );
}

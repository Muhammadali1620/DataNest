// What the data comparison page (V8.4) works out itself: which columns to show when
// only differing ones are wanted, and how many more rows there are to load.

import type {
  DataCompareRow,
  DataCompareState,
  RowKind,
} from '../../../../src/shared/protocols/data-compare';

/** Column indexes (key first) worth showing: the key, and columns that differ somewhere. */
export function shownColumns(
  rows: readonly DataCompareRow[],
  keyWidth: number,
  total: number,
  onlyDiffering: boolean,
): number[] {
  const all = Array.from({ length: total }, (_, index) => index);
  if (!onlyDiffering) {
    return all;
  }
  return all.filter(
    (index) => index < keyWidth || rows.some((row) => row.differs?.[index] === true),
  );
}

/** Rows of a kind the host kept, and how many there are in all. */
export function rowCounts(
  result: NonNullable<DataCompareState['result']>,
  kind: RowKind,
): { kept: number; total: number } {
  return { kept: result.kept[kind], total: result[kind] };
}

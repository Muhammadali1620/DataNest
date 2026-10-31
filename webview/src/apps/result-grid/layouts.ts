// The other ways to lay out the loaded rows: as JSON, or with fields running down.
// Pure, so how every kind of value turns into JSON is a unit test.

import { cellText } from '../../../../src/shared/cell-text';
import { type CellValue, isTaggedValue } from '../../../../src/shared/cell-value';

/** More rows than this are not laid out this way: it is a way to look, not to read a table. */
export const LAYOUT_ROWS = 100;

/** A cell as a value JSON can hold: numbers and booleans as they are, the rest as text. */
export function jsonOf(value: CellValue): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (isTaggedValue(value)) {
    if (value.kind === 'json') {
      try {
        return JSON.parse(value.text) as unknown;
      } catch {
        return value.text;
      }
    }
    if (value.kind === 'binary') {
      return `<${value.size} bytes>`;
    }
  }
  return cellText(value);
}

/** Rows as an array of objects, one key per column; a repeated name keeps its last value. */
export function rowsToJson(
  columns: readonly { readonly name: string }[],
  rows: readonly (readonly CellValue[])[],
): string {
  const objects = rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column.name, jsonOf(row[index] ?? null)])),
  );
  return JSON.stringify(objects, null, 2);
}

export interface Transposed {
  /** Header cells: "row 1", "row 2", … */
  readonly heads: readonly number[];
  /** One line per column: its name and the value in each row. */
  readonly lines: readonly { readonly name: string; readonly cells: readonly CellValue[] }[];
}

/** Fields run down, rows run across. */
export function transpose(
  columns: readonly { readonly name: string }[],
  rows: readonly (readonly CellValue[])[],
): Transposed {
  return {
    heads: rows.map((_, index) => index + 1),
    lines: columns.map((column, index) => ({
      name: column.name,
      cells: rows.map((row) => row[index] ?? null),
    })),
  };
}

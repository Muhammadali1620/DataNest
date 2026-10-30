// Rows of the monitor's queries (V8.5) by column name: servers spell names in their own
// case (Oracle upper, SHOW PROCESSLIST mixed), so names are matched in lower case.

import type { Session } from '../../drivers/driver';
import type { CellValue } from '../../shared/cell-value';
import { cellText } from '../../shared/cell-text';
import { resultSets } from '../explain/explain';

export type NamedRow = ReadonlyMap<string, CellValue>;

/** The rows of the last set a statement returns, each by lower-case column name. */
export async function namedRows(session: Session, sql: string): Promise<NamedRow[]> {
  const sets = await resultSets(session, sql);
  const set = sets.at(-1);
  if (set === undefined) {
    return [];
  }
  const names = set.columns.map((name) => name.toLowerCase());
  return set.rows.map((row) => new Map(names.map((name, index) => [name, row[index] ?? null])));
}

/** The text of a column, undefined for NULL, a missing column or an empty text. */
export function textOf(row: NamedRow, name: string): string | undefined {
  const value = row.get(name);
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = cellText(value);
  return text === '' ? undefined : text;
}

/** A column as a number, undefined where it is not one. */
export function numberOf(row: NamedRow, name: string): number | undefined {
  return toNumber(textOf(row, name));
}

export function toNumber(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The first column of the first row as text. */
export async function firstValue(session: Session, sql: string): Promise<string | undefined> {
  const [row] = await namedRows(session, sql);
  const first = row?.values().next();
  return first === undefined || first.done === true || first.value === null
    ? undefined
    : cellText(first.value);
}

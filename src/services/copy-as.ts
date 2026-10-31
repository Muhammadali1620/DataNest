// "Copy as": the selected cells rendered as SQL, JSON, CSV, Markdown or an IN list.
// SQL goes through the Dialect like everything else (ARCHITECTURE.md §8), so a value
// with a quote in it cannot break out of the statement it is pasted into.

import type { CopyError, CopyFormat } from '../shared/copy-format';
import { cellJson, cellText, isNumericValue } from '../shared/cell-text';
import type { CellValue } from '../shared/cell-value';
import { toCsv } from '../shared/csv';
import { toTsv } from '../shared/tsv';
import type { ResultEdit } from '../core/model/editability';
import type { Dialect, ResultColumn } from '../drivers/driver';
import { columnNames } from './column-names';
import { literalOf } from './sql-literal';

export interface CopyInput {
  readonly format: CopyFormat;
  readonly columns: readonly ResultColumn[];
  /** The rows to copy, full width: UPDATE needs the key even when it is not selected. */
  readonly rows: readonly (readonly CellValue[])[];
  /** The result columns to copy, in the order they were on screen. */
  readonly selected: readonly number[];
  /** Needed for SQL output; absent when the result's connection is unknown. */
  readonly dialect?: Dialect | undefined;
  readonly edit?: ResultEdit | undefined;
}

export type CopyOutcome =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: CopyError };

/** What stands in for the table name when the result is not a plain table. */
export const PLACEHOLDER_TABLE = 'table_name';

export function copyAs(input: CopyInput): CopyOutcome {
  const indexes = input.selected;
  switch (input.format) {
    case 'tsv':
      return text(
        toTsv(
          input.rows.map((row) => pick(row, indexes)),
          { header: pick(columnNames(input.columns), indexes) },
        ),
      );
    case 'csv':
      return text(
        toCsv(
          input.rows.map((row) => pick(row, indexes)),
          { header: pick(columnNames(input.columns), indexes) },
        ),
      );
    case 'json':
      return text(json(input, indexes));
    case 'markdown':
      return text(markdown(input, indexes));
    case 'insert':
    case 'update':
    case 'in':
      return input.dialect === undefined
        ? { ok: false, error: 'nothing-to-write' }
        : sql(input, input.dialect, indexes);
  }
}

function sql(input: CopyInput, dialect: Dialect, indexes: readonly number[]): CopyOutcome {
  if (input.format === 'insert') {
    return insert(input, dialect, indexes);
  }
  return input.format === 'update' ? update(input, dialect, indexes) : inList(input, dialect);
}

function text(value: string): CopyOutcome {
  return { ok: true, text: value };
}

function pick<T>(items: readonly T[], indexes: readonly number[]): T[] {
  return indexes.flatMap((index) => (index < items.length ? [items[index] as T] : []));
}

function json(input: CopyInput, indexes: readonly number[]): string {
  const names = columnNames(input.columns);
  const records = input.rows.map((row) => {
    const record: Record<string, unknown> = {};
    for (const index of indexes) {
      record[names[index] ?? `column${index + 1}`] = cellJson(row[index] ?? null);
    }
    return record;
  });
  return JSON.stringify(records, undefined, 2);
}

/** A GitHub-flavoured table; numeric columns are right-aligned. */
function markdown(input: CopyInput, indexes: readonly number[]): string {
  const names = columnNames(input.columns);
  const escape = (value: string): string =>
    value.replaceAll('|', '\\|').replace(/\r\n|\r|\n/g, '<br>');
  const header = indexes.map((index) => escape(names[index] ?? ''));
  const align = indexes.map((index) => {
    const values = input.rows.map((row) => row[index] ?? null).filter((cell) => cell !== null);
    return values.length > 0 && values.every(isNumericValue) ? '---:' : '---';
  });
  const body = input.rows.map((row) =>
    indexes.map((index) => escape(cellText(row[index] ?? null, { nullText: 'NULL' }))),
  );
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(align), ...body.map(line)].join('\n');
}

/** The table column behind a result column, or undefined for one that cannot be written. */
function writableName(input: CopyInput, index: number): string | undefined {
  if (input.edit?.editable === true) {
    return input.edit.columnMap[index] ?? undefined;
  }
  const name = input.columns[index]?.name;
  return name === undefined || name === '' ? undefined : name;
}

function tableSql(dialect: Dialect, input: CopyInput): string {
  return input.edit?.editable === true
    ? dialect.quoteTable(input.edit.table)
    : dialect.quoteIdentifier(PLACEHOLDER_TABLE);
}

function insert(input: CopyInput, dialect: Dialect, indexes: readonly number[]): CopyOutcome {
  const writable = indexes.filter((index) => writableName(input, index) !== undefined);
  if (writable.length === 0 || input.rows.length === 0) {
    return { ok: false, error: 'nothing-to-write' };
  }
  const columns = writable
    .map((index) => dialect.quoteIdentifier(writableName(input, index) ?? ''))
    .join(', ');
  const statements = input.rows.map((row) => {
    const values = writable.map((index) => literalOf(dialect, row[index] ?? null));
    return `INSERT INTO ${tableSql(dialect, input)} (${columns}) VALUES (${values.join(', ')});`;
  });
  return text(statements.join('\n'));
}

function update(input: CopyInput, dialect: Dialect, indexes: readonly number[]): CopyOutcome {
  const edit = input.edit;
  if (edit?.editable !== true) {
    return { ok: false, error: 'no-key' };
  }
  const settable = indexes.filter(
    (index) =>
      (edit.keyless === true || !edit.keyIndexes.includes(index)) &&
      writableName(input, index) !== undefined,
  );
  if (settable.length === 0 || input.rows.length === 0) {
    return { ok: false, error: 'nothing-to-write' };
  }
  const statements = input.rows.map((row) => {
    const set = settable
      .map(
        (index) =>
          `${dialect.quoteIdentifier(writableName(input, index) ?? '')} = ${literalOf(dialect, row[index] ?? null)}`,
      )
      .join(', ');
    const where = edit.keyIndexes
      .map((index, position) => {
        const key = dialect.quoteIdentifier(edit.keyColumns[position] ?? '');
        const value = row[index] ?? null;
        return value === null ? `${key} IS NULL` : `${key} = ${literalOf(dialect, value)}`;
      })
      .join(' AND ');
    return `UPDATE ${tableSql(dialect, input)} SET ${set} WHERE ${where};`;
  });
  return text(statements.join('\n'));
}

/** `(1, 2, 'x')` from the first selected column: distinct, NULLs left out (they never match). */
function inList(input: CopyInput, dialect: Dialect): CopyOutcome {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const row of input.rows) {
    const cell = row[input.selected[0] ?? 0] ?? null;
    if (cell === null) {
      continue;
    }
    const literal = literalOf(dialect, cell);
    if (!seen.has(literal)) {
      seen.add(literal);
      items.push(literal);
    }
  }
  return items.length === 0 ? { ok: false, error: 'no-values' } : text(`(${items.join(', ')})`);
}

// Decides whether a query result can be edited in place. Editing needs to know
// exactly which table row each result row is, so the rule is strict: one table, no
// aggregation, and a key (primary or unique, never NULL) present in the result.

import { enumOptions, type InputKind, inputKindOf } from '../../shared/cell-input';
import type { ReadOnlyReason } from '../../shared/read-only-reason';
import type { SelectItem } from '../sql/select-source';
import type { ColumnInfo, TableKind, TableRef } from './objects';

/** What the grid needs to edit one result column. */
export interface EditableColumn {
  /** The table column behind it. */
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  /** Which editor it gets. */
  readonly kind: InputKind;
  /** Allowed values of an enum column. */
  readonly options?: readonly string[];
  /** The column's default expression as the server reports it. */
  readonly defaultValue?: string;
}

export interface EditableResult {
  readonly editable: true;
  /** The table as the server names it. */
  readonly table: TableRef;
  /** Table column behind each result column; null for computed ones. */
  readonly columnMap: readonly (string | null)[];
  /** Per result column: how to edit it, or null for a computed one. */
  readonly columns: readonly (EditableColumn | null)[];
  /** Key column names, and where each one sits in the result. */
  readonly keyColumns: readonly string[];
  readonly keyIndexes: readonly number[];
}

export interface ReadOnlyResult {
  readonly editable: false;
  readonly reason: ReadOnlyReason;
}

export type ResultEdit = EditableResult | ReadOnlyResult;

export interface EditabilityInput {
  readonly table: TableRef;
  readonly kind: TableKind;
  readonly columns: readonly ColumnInfo[];
  /** Unique indexes, as column names in index order. */
  readonly uniqueKeys: readonly (readonly string[])[];
  readonly items: readonly SelectItem[];
  /** Names of the result columns, in order. */
  readonly resultColumns: readonly string[];
}

function readOnly(reason: ReadOnlyReason): ReadOnlyResult {
  return { editable: false, reason };
}

export function readOnlyResult(reason: ReadOnlyReason): ReadOnlyResult {
  return readOnly(reason);
}

/** Case-insensitive lookup that prefers an exact match. */
export function findByName<T extends { readonly name: string }>(
  list: readonly T[],
  name: string,
): T | undefined {
  const exact = list.find((entry) => entry.name === name);
  if (exact !== undefined) {
    return exact;
  }
  const lower = name.toLowerCase();
  const loose = list.filter((entry) => entry.name.toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : undefined;
}

/** The columns that identify a row: the primary key, else the shortest usable unique key. */
export function chooseKey(
  columns: readonly ColumnInfo[],
  uniqueKeys: readonly (readonly string[])[],
): string[] | undefined {
  const primary = columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (primary.length > 0) {
    return primary;
  }
  const usable = uniqueKeys
    .filter(
      (key) =>
        key.length > 0 &&
        key.every((name) => {
          const column = findByName(columns, name);
          return column !== undefined && !column.nullable;
        }),
    )
    .map((key) => [...key]);
  usable.sort((a, b) => a.length - b.length);
  return usable[0];
}

export function resolveEditability(input: EditabilityInput): ResultEdit {
  if (input.kind === 'view') {
    return readOnly('view');
  }
  // Which table column each result column shows.
  const columnMap: (string | null)[] = [];
  for (const item of input.items) {
    if (item.kind === 'star') {
      columnMap.push(...input.columns.map((column) => column.name));
    } else if (item.kind === 'column') {
      const column = findByName(input.columns, item.name);
      columnMap.push(column === undefined ? null : column.name);
    } else {
      columnMap.push(null);
    }
  }
  if (columnMap.length !== input.resultColumns.length) {
    return readOnly('columns-mismatch');
  }
  // A star or alias that names something else means we misread the statement.
  const labels = input.items.flatMap((item) =>
    item.kind === 'star'
      ? input.columns.map((column) => column.name)
      : item.kind === 'column'
        ? [item.output]
        : [undefined],
  );
  const misread = labels.some(
    (label, index) =>
      label !== undefined && label.toLowerCase() !== input.resultColumns[index]?.toLowerCase(),
  );
  if (misread) {
    return readOnly('columns-mismatch');
  }

  const key = chooseKey(input.columns, input.uniqueKeys);
  if (key === undefined) {
    return readOnly('no-key');
  }
  const keyIndexes: number[] = [];
  for (const name of key) {
    const index = columnMap.indexOf(findByName(input.columns, name)?.name ?? name);
    if (index === -1) {
      return readOnly('key-not-selected');
    }
    keyIndexes.push(index);
  }
  // A binary key cannot be written back exactly (only a preview of it is held).
  if (key.some((name) => inputKindOf(findByName(input.columns, name)?.dataType) === 'binary')) {
    return readOnly('no-key');
  }
  const columns = columnMap.map((name): EditableColumn | null => {
    const info = name === null ? undefined : findByName(input.columns, name);
    if (info === undefined) {
      return null;
    }
    const options = enumOptions(info.dataType);
    return {
      name: info.name,
      dataType: info.dataType,
      nullable: info.nullable,
      kind: inputKindOf(info.dataType),
      ...(options === undefined ? {} : { options }),
      ...(info.defaultValue === undefined ? {} : { defaultValue: info.defaultValue }),
    };
  });
  return { editable: true, table: input.table, columnMap, columns, keyColumns: key, keyIndexes };
}

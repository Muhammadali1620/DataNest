// Decides whether a query result can be edited in place. Editing needs to know
// exactly which table row each result row is, so the rule is strict: one table, no
// aggregation, and a key (primary or unique, never NULL) present in the result. A
// table without a key is edited by the values of its whole row (V10.2.4): saving then
// checks that exactly one row matched, and puts everything back otherwise.

import { enumOptions, type InputKind, inputKindOf } from '../../shared/cell-input';
import type { DriverId } from '../../shared/connection';
import type { ReadOnlyReason } from '../../shared/read-only-reason';
import type { SelectItem } from '../sql/select-source';
import type { ColumnInfo, ForeignKey, TableKind, TableRef } from './objects';

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
  /**
   * The table has no key: a row is found by the values of all its columns that can be
   * compared exactly, and the "key" is those columns (V10.2.4). Nothing about them is
   * unique, so a duplicated row copies them too.
   */
  readonly keyless?: true;
  /** Foreign keys of the table, so a cell can lead to the row it points at (V2.13). */
  readonly foreignKeys?: readonly ForeignKey[];
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
  /** For the types whose meaning depends on the database (Oracle's DATE). */
  readonly driver?: DriverId;
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

  const chosen = chooseKey(input.columns, input.uniqueKeys);
  const key = chosen ?? valueKey(input.columns, columnMap, input.driver);
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
  if (
    key.some(
      (name) => inputKindOf(findByName(input.columns, name)?.dataType, input.driver) === 'binary',
    )
  ) {
    return readOnly('no-key');
  }
  const columns = columnMap.map((name): EditableColumn | null => {
    const info = name === null ? undefined : findByName(input.columns, name);
    if (info === undefined || isSpatial(info.dataType, input.driver)) {
      return null;
    }
    const options = enumOptions(info.dataType);
    return {
      name: info.name,
      dataType: info.dataType,
      nullable: info.nullable,
      kind: inputKindOf(info.dataType, input.driver),
      ...(options === undefined ? {} : { options }),
      ...(info.defaultValue === undefined ? {} : { defaultValue: info.defaultValue }),
    };
  });
  return {
    editable: true,
    table: input.table,
    columnMap,
    columns,
    keyColumns: key,
    keyIndexes,
    ...(chosen === undefined ? { keyless: true as const } : {}),
  };
}

/** Types whose `=` is not exact, or that have no `=` at all, on some server. */
const INEXACT_TYPES =
  /^(float\d*|double|real|n?clob|long\b|xml|xmltype|geometry|geography|geomcollection|point|line|lseg|box|path|polygon|circle|multi(point|linestring|polygon)|hierarchyid|sql_variant|tsvector|tsquery)/u;

/** Spatial types shown as WKT (MySQL) or EWKB text (PostGIS): not edited as text. */
const SPATIAL_TYPES =
  /^(geometry|geography|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)\b/u;

/** True for a column the grid shows but cannot write back as typed text (V10.2.4). */
export function isSpatial(dataType: string, driver?: DriverId): boolean {
  const type = dataType.trim().toLowerCase();
  // PostgreSQL's own point, line and polygon are text types; only PostGIS's are spatial.
  return driver === 'postgres' ? /^(geometry|geography)\b/u.test(type) : SPATIAL_TYPES.test(type);
}

/** Old large types of SQL Server, which cannot be compared at all. */
const MSSQL_LOBS = /^(n?text|image|timestamp|rowversion)$/u;

/** True when `column = <its value as read>` finds the row the value came from. */
export function comparesExactly(dataType: string, driver?: DriverId): boolean {
  const kind = inputKindOf(dataType, driver);
  if (kind === 'binary' || kind === 'json') {
    return false;
  }
  const type = dataType.trim().toLowerCase();
  return !INEXACT_TYPES.test(type) && !(driver === 'mssql' && MSSQL_LOBS.test(type));
}

/**
 * Without a key, the row is found by its values: possible when the result shows every
 * column of the table, by the columns that compare exactly (at least one).
 */
function valueKey(
  columns: readonly ColumnInfo[],
  columnMap: readonly (string | null)[],
  driver: DriverId | undefined,
): string[] | undefined {
  if (!columns.every((column) => columnMap.includes(column.name))) {
    return undefined;
  }
  const exact = columns
    .filter((column) => comparesExactly(column.dataType, driver))
    .map((column) => column.name);
  return exact.length === 0 ? undefined : exact;
}

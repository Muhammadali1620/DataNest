// What changed between the design a table was loaded with and the one the user
// wants. Columns, indexes and keys are matched by id, never by name, so a rename
// is a rename and not a drop plus an add. The dialects turn this into ALTER.

import {
  type ColumnDesign,
  composeType,
  type ForeignKeyDesign,
  type IndexDesign,
  type TableDesign,
} from './table-design';

/** A column that exists before and after, with what changed about it. */
export interface ColumnChange {
  readonly before: ColumnDesign;
  readonly after: ColumnDesign;
  readonly renamed: boolean;
  readonly type: boolean;
  readonly nullable: boolean;
  readonly defaultValue: boolean;
  readonly autoIncrement: boolean;
  readonly comment: boolean;
}

export interface TableDiff {
  readonly renamed: boolean;
  readonly comment: boolean;
  /** Columns of the old table that are gone, in their old order. */
  readonly dropped: readonly ColumnDesign[];
  /** New columns, in their new order. */
  readonly added: readonly ColumnDesign[];
  /** Kept columns with any change, in their new order. */
  readonly changed: readonly ColumnChange[];
  /** The order of kept columns changed, or a new column is not at the end. */
  readonly order: boolean;
  /** The primary key columns (or their order) changed. */
  readonly primaryKey: boolean;
  /** Indexes and keys are never altered in place: a changed one is dropped and added. */
  readonly droppedIndexes: readonly IndexDesign[];
  readonly addedIndexes: readonly IndexDesign[];
  readonly droppedKeys: readonly ForeignKeyDesign[];
  readonly addedKeys: readonly ForeignKeyDesign[];
}

/** Types compare without case and extra spaces: `VARCHAR(10)` is `varchar(10)`. */
function typeOf(column: ColumnDesign): string {
  return composeType(column.type, column.length)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',');
}

function columnChange(before: ColumnDesign, after: ColumnDesign): ColumnChange | undefined {
  const change: ColumnChange = {
    before,
    after,
    renamed: before.name.trim() !== after.name.trim(),
    type: typeOf(before) !== typeOf(after),
    nullable: before.nullable !== after.nullable,
    defaultValue: before.defaultValue.trim() !== after.defaultValue.trim(),
    autoIncrement: before.autoIncrement !== after.autoIncrement,
    comment: before.comment !== after.comment,
  };
  const any =
    change.renamed ||
    change.type ||
    change.nullable ||
    change.defaultValue ||
    change.autoIncrement ||
    change.comment;
  return any ? change : undefined;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameIndex(a: IndexDesign, b: IndexDesign): boolean {
  return a.name.trim() === b.name.trim() && a.unique === b.unique && sameList(a.columns, b.columns);
}

function sameKey(a: ForeignKeyDesign, b: ForeignKeyDesign): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    sameList(a.columns, b.columns) &&
    (a.targetSchema ?? '') === (b.targetSchema ?? '') &&
    a.targetTable.trim() === b.targetTable.trim() &&
    sameList(
      a.targetColumns.map((column) => column.trim()),
      b.targetColumns.map((column) => column.trim()),
    ) &&
    a.onDelete === b.onDelete &&
    a.onUpdate === b.onUpdate
  );
}

/** Items that are new or changed (`added`) and old or changed (`dropped`), by id. */
function partsDiff<T extends { readonly id: string }>(
  before: readonly T[],
  after: readonly T[],
  same: (a: T, b: T) => boolean,
): { dropped: T[]; added: T[] } {
  const old = new Map(before.map((item) => [item.id, item]));
  const fresh = new Map(after.map((item) => [item.id, item]));
  const dropped = before.filter((item) => {
    const next = fresh.get(item.id);
    return next === undefined || !same(item, next);
  });
  const added = after.filter((item) => {
    const previous = old.get(item.id);
    return previous === undefined || !same(previous, item);
  });
  return { dropped, added };
}

export function diffTables(before: TableDesign, after: TableDesign): TableDiff {
  const old = new Map(before.columns.map((column) => [column.id, column]));
  const kept = new Set(after.columns.filter((column) => old.has(column.id)).map((c) => c.id));
  const dropped = before.columns.filter((column) => !kept.has(column.id));
  const added = after.columns.filter((column) => !old.has(column.id));
  const changed = after.columns.flatMap((column) => {
    const previous = old.get(column.id);
    const change = previous === undefined ? undefined : columnChange(previous, column);
    return change === undefined ? [] : [change];
  });
  const keptBefore = before.columns.filter((column) => kept.has(column.id)).map((c) => c.id);
  const keptAfter = after.columns.filter((column) => kept.has(column.id)).map((c) => c.id);
  const firstAdded = after.columns.findIndex((column) => !old.has(column.id));
  const order =
    !sameList(keptBefore, keptAfter) ||
    (firstAdded !== -1 && after.columns.slice(firstAdded).some((column) => old.has(column.id)));
  const keyOf = (design: TableDesign) =>
    design.columns.filter((column) => column.primaryKey).map((column) => column.id);
  const indexes = partsDiff(before.indexes, after.indexes, sameIndex);
  const keys = partsDiff(before.foreignKeys, after.foreignKeys, sameKey);
  return {
    renamed: before.name.trim() !== after.name.trim(),
    comment: before.comment !== after.comment,
    dropped,
    added,
    changed,
    order,
    primaryKey: !sameList(keyOf(before), keyOf(after)),
    droppedIndexes: indexes.dropped,
    addedIndexes: indexes.added,
    droppedKeys: keys.dropped,
    addedKeys: keys.added,
  };
}

/** True when saving would change nothing. */
export function isEmptyDiff(diff: TableDiff): boolean {
  return (
    !diff.renamed &&
    !diff.comment &&
    diff.dropped.length === 0 &&
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    !diff.order &&
    !diff.primaryKey &&
    diff.droppedIndexes.length === 0 &&
    diff.addedIndexes.length === 0 &&
    diff.droppedKeys.length === 0 &&
    diff.addedKeys.length === 0
  );
}

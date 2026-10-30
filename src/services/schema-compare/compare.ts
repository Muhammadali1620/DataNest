// Comparing two schemas (V8.3): tables by their designs, so the differences are the
// ones the designer's ALTER can make, and every other object by its definition with
// the source schema's name put in place of the target's.

import type { ObjectKind, ObjectRef, ObjectScope } from '../../core/model/objects';
import type { DriverId } from '../../shared/connection';
import type {
  ColumnDesign,
  ForeignKeyDesign,
  IndexDesign,
  TableDesign,
} from '../../shared/table-design';
import { diffTables, isEmptyDiff, type TableDiff } from '../../shared/table-diff';
import { normalizeDefinition, retargetScope } from './retarget';
import type { SchemaSnapshot, TableSnapshot } from './snapshot';

/** Only in the source (to create), only in the target (to drop), different, or equal. */
export type CompareStatus = 'added' | 'removed' | 'changed' | 'same';

interface ItemBase {
  /** Stable within one comparison, so the page can pick items. */
  readonly id: string;
  readonly name: string;
  readonly status: CompareStatus;
}

export interface TableItem extends ItemBase {
  readonly kind: 'table';
  readonly source?: TableSnapshot;
  readonly target?: TableSnapshot;
  /** The source's design with the target's ids, which ALTER turns the target into. */
  readonly after?: TableDesign;
  readonly diff?: TableDiff;
  /** Differences a script cannot make: generated columns, expression indexes. */
  readonly notes: readonly string[];
}

export interface ObjectItem extends ItemBase {
  readonly kind: Exclude<ObjectKind, 'table'>;
  /** Where it lives in the target, for DROP. */
  readonly ref: ObjectRef;
  /** The source's statements, naming the target schema. */
  readonly source?: readonly string[];
  readonly target?: readonly string[];
  /** One side's definition could not be read, so it cannot be compared. */
  readonly hidden?: string;
}

export type CompareItem = TableItem | ObjectItem;

export interface CompareContext {
  readonly driver: DriverId;
  readonly quote: (name: string) => string;
}

export function compareSchemas(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  context: CompareContext,
): CompareItem[] {
  return [...compareTables(source, target), ...compareObjects(source, target, context)];
}

function compareTables(source: SchemaSnapshot, target: SchemaSnapshot): TableItem[] {
  const theirs = new Map(target.tables.map((table) => [table.name, table]));
  const items: TableItem[] = [];
  for (const ours of source.tables) {
    const other = theirs.get(ours.name);
    theirs.delete(ours.name);
    if (other === undefined) {
      items.push({
        kind: 'table',
        id: `table:${ours.name}`,
        name: ours.name,
        status: 'added',
        source: ours,
        notes: createNotes(ours),
      });
      continue;
    }
    const after = alignDesign(other.loaded.design, ours.loaded.design);
    const diff = diffTables(other.loaded.design, after);
    const notes = backgroundNotes(ours, other);
    items.push({
      kind: 'table',
      id: `table:${ours.name}`,
      name: ours.name,
      status: isEmptyDiff(diff) && notes.length === 0 ? 'same' : 'changed',
      source: ours,
      target: other,
      after,
      diff,
      notes,
    });
  }
  for (const other of theirs.values()) {
    items.push({
      kind: 'table',
      id: `table:${other.name}`,
      name: other.name,
      status: 'removed',
      target: other,
      notes: [],
    });
  }
  return items;
}

/**
 * The source design as an edit of the target's: a column, index or key with the same
 * name keeps the target's id and original name, the rest are new. Kept columns stay in
 * the target's order and new ones go last: moving columns is rarely wanted, and
 * PostgreSQL cannot do it.
 */
export function alignDesign(before: TableDesign, source: TableDesign): TableDesign {
  const beforeColumns = new Map(before.columns.map((column) => [column.name, column]));
  const idOf = new Map<string, string>();
  let fresh = 0;
  const newId = (prefix: string): string => {
    fresh += 1;
    return `new-${prefix}-${fresh}`;
  };
  const mapped: ColumnDesign[] = source.columns.map((column) => {
    const match = beforeColumns.get(column.name);
    const id = match?.id ?? newId('col');
    idOf.set(column.id, id);
    const { original: _original, ...rest } = column;
    return { ...rest, id, ...(match?.original === undefined ? {} : { original: match.original }) };
  });
  const position = new Map(before.columns.map((column, index) => [column.id, index]));
  const columns = [
    ...mapped
      .filter((column) => position.has(column.id))
      .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)),
    ...mapped.filter((column) => !position.has(column.id)),
  ];
  const remap = (ids: readonly string[]): string[] => ids.map((id) => idOf.get(id) ?? id);
  const beforeIndexes = new Map(before.indexes.map((index) => [index.name, index]));
  const indexes: IndexDesign[] = source.indexes.map((index) => {
    const match = beforeIndexes.get(index.name);
    const { original: _original, ...rest } = index;
    return {
      ...rest,
      id: match?.id ?? newId('index'),
      ...(match?.original === undefined ? {} : { original: match.original }),
      columns: remap(index.columns),
    };
  });
  const beforeKeys = new Map(before.foreignKeys.map((key) => [key.name, key]));
  const foreignKeys: ForeignKeyDesign[] = source.foreignKeys.map((key) => {
    const match = beforeKeys.get(key.name);
    const { original: _original, ...rest } = key;
    return {
      ...rest,
      id: match?.id ?? newId('key'),
      ...(match?.original === undefined ? {} : { original: match.original }),
      columns: remap(key.columns),
    };
  });
  return { name: before.name, comment: source.comment, columns, indexes, foreignKeys };
}

/** What a created table will lack, because the designer does not write it. */
function createNotes(table: TableSnapshot): string[] {
  const { background } = table.loaded;
  return [
    ...background.generatedColumns.map((column) => `generated column ${column} is not created`),
    ...background.fixedIndexes.map(
      (index) => `index ${index.name} ${index.description} is not created`,
    ),
  ];
}

function backgroundNotes(source: TableSnapshot, target: TableSnapshot): string[] {
  const notes: string[] = [];
  const generated = (table: TableSnapshot) => new Set(table.loaded.background.generatedColumns);
  const ours = generated(source);
  const theirs = generated(target);
  for (const column of ours) {
    if (!theirs.has(column)) {
      notes.push(`generated column ${column} is only in the source`);
    }
  }
  for (const column of theirs) {
    if (!ours.has(column)) {
      notes.push(`generated column ${column} is only in the target`);
    }
  }
  const fixed = (table: TableSnapshot) =>
    new Map(table.loaded.background.fixedIndexes.map((index) => [index.name, index.description]));
  const ourIndexes = fixed(source);
  const theirIndexes = fixed(target);
  for (const [name, description] of ourIndexes) {
    if (theirIndexes.get(name) !== description) {
      notes.push(`index ${name} ${description} differs and is not changed`);
    }
  }
  for (const name of theirIndexes.keys()) {
    if (!ourIndexes.has(name)) {
      notes.push(`index ${name} is only in the target and is not dropped`);
    }
  }
  return notes;
}

function objectKey(ref: ObjectRef): string {
  return JSON.stringify([ref.kind, ref.name, ref.table ?? '', ref.signature ?? '']);
}

function compareObjects(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  context: CompareContext,
): ObjectItem[] {
  const from = scopeName(source.scope);
  const to = scopeName(target.scope);
  const retarget = (statements: readonly string[] | undefined): string[] | undefined =>
    statements?.map((sql) => retargetScope(sql, from, to, context.driver, context.quote));
  const theirs = new Map(target.objects.map((object) => [objectKey(object.ref), object]));
  const items: ObjectItem[] = [];
  for (const ours of source.objects) {
    const key = objectKey(ours.ref);
    const other = theirs.get(key);
    theirs.delete(key);
    const statements = retarget(ours.statements);
    const ref = retargetRef(other?.ref ?? ours.ref, target.scope);
    const id = `object:${key}`;
    const kind = ours.ref.kind as ObjectItem['kind'];
    if (other === undefined) {
      items.push({
        kind,
        id,
        name: ours.ref.name,
        status: 'added',
        ref,
        ...(statements === undefined ? {} : { source: statements }),
        ...(ours.hidden === undefined ? {} : { hidden: ours.hidden }),
      });
      continue;
    }
    const hidden = ours.hidden ?? other.hidden;
    const same =
      hidden === undefined &&
      normalizeDefinition(statements ?? []) === normalizeDefinition(other.statements ?? []);
    items.push({
      kind,
      id,
      name: ours.ref.name,
      status: hidden !== undefined || same ? 'same' : 'changed',
      ref,
      ...(statements === undefined ? {} : { source: statements }),
      ...(other.statements === undefined ? {} : { target: other.statements }),
      ...(hidden === undefined ? {} : { hidden }),
    });
  }
  for (const other of theirs.values()) {
    items.push({
      kind: other.ref.kind as ObjectItem['kind'],
      id: `object:${objectKey(other.ref)}`,
      name: other.ref.name,
      status: 'removed',
      ref: other.ref,
      ...(other.statements === undefined ? {} : { target: other.statements }),
      ...(other.hidden === undefined ? {} : { hidden: other.hidden }),
    });
  }
  return items;
}

/** The name definitions qualify objects with: the schema, or the database (MySQL). */
export function scopeName(scope: ObjectScope): string | undefined {
  return scope.schema ?? scope.database;
}

function retargetRef(ref: ObjectRef, scope: ObjectScope): ObjectRef {
  const { database: _database, schema: _schema, ...rest } = ref;
  return { ...rest, ...scope };
}

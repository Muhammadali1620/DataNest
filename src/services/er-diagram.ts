// What an ER diagram (V8.1) shows: the tables of a scope with their columns and the
// foreign keys between them, read through the metadata reader table by table.

import { DbError } from '../core/errors';
import type { ObjectScope, TableRef } from '../core/model/objects';
import type { MetadataReader } from '../drivers/driver';
import { msg } from '../core/user-message';

export interface ErColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  /** The column is part of a foreign key of its table. */
  readonly foreignKey: boolean;
}

export interface ErTable {
  /** Unique within the diagram: the bare name for a table of the scope. */
  readonly id: string;
  /** What the box says: the bare name, or `schema.name` for a table of another scope. */
  readonly label: string;
  readonly columns: readonly ErColumn[];
  /**
   * A table outside the scope that a key points at. Only the referenced columns are
   * known; it is drawn apart, so the user sees where the key leads.
   */
  readonly external?: true;
}

export interface ErRelation {
  readonly name: string;
  /** Id of the table that holds the key. */
  readonly from: string;
  readonly columns: readonly string[];
  /** Id of the table the key points at. */
  readonly to: string;
  readonly targetColumns: readonly string[];
  /** Every key column allows NULL: a row may point at nothing. */
  readonly optional: boolean;
}

export interface ErSchema {
  readonly tables: readonly ErTable[];
  readonly relations: readonly ErRelation[];
}

export interface ErReadOptions {
  /** Only these tables (bare names); every table of the scope when absent. */
  readonly tables?: readonly string[];
  readonly signal?: AbortSignal;
  /** Called after each table, with how many are read and how many there are. */
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Reads tables, columns and foreign keys. Views are left out: they have no keys of
 * their own. A key that points at a table of another scope (or a table not chosen)
 * brings that table in as an external one with just the referenced columns.
 */
export async function readErSchema(
  metadata: MetadataReader,
  scope: ObjectScope,
  options: ErReadOptions = {},
): Promise<ErSchema> {
  const listed = (await metadata.listTables(scope)).filter((table) => table.kind === 'table');
  const wanted = options.tables === undefined ? undefined : new Set(options.tables);
  const names = listed
    .map((table) => table.name)
    .filter((name) => wanted === undefined || wanted.has(name));
  const tables: ErTable[] = [];
  const relations: ErRelation[] = [];
  const inScope = new Set(names);
  const external = new Map<string, { label: string; columns: Set<string> }>();
  for (const [index, name] of names.entries()) {
    throwIfAborted(options.signal);
    const ref: TableRef = { ...scope, name };
    const columns = await metadata.listColumns(ref);
    const keys = await metadata.listForeignKeys(ref);
    const keyColumns = new Set(keys.flatMap((key) => key.columns));
    tables.push({
      id: name,
      label: name,
      columns: columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
        foreignKey: keyColumns.has(column.name),
      })),
    });
    const nullable = new Map(columns.map((column) => [column.name, column.nullable]));
    for (const key of keys) {
      const local = sameScope(key.target, scope) && inScope.has(key.target.name);
      const to = local ? key.target.name : externalId(key.target);
      if (!local) {
        const entry = external.get(to) ?? {
          label: externalLabel(key.target, scope),
          columns: new Set<string>(),
        };
        for (const column of key.targetColumns) {
          entry.columns.add(column);
        }
        external.set(to, entry);
      }
      relations.push({
        name: key.name,
        from: name,
        columns: key.columns,
        to,
        targetColumns: key.targetColumns,
        optional: key.columns.length > 0 && key.columns.every((column) => nullable.get(column)),
      });
    }
    options.onProgress?.(index + 1, names.length);
  }
  for (const [id, entry] of external) {
    tables.push({
      id,
      label: entry.label,
      external: true,
      columns: [...entry.columns].map((column) => ({
        name: column,
        dataType: '',
        nullable: false,
        primaryKey: false,
        foreignKey: false,
      })),
    });
  }
  return { tables, relations };
}

function sameScope(target: ObjectScope, scope: ObjectScope): boolean {
  return (
    (target.schema === undefined || target.schema === scope.schema) &&
    (target.database === undefined || target.database === scope.database)
  );
}

/** Cannot equal a bare table name of the scope: those never start with a control character. */
function externalId(target: TableRef): string {
  return `\u0001${JSON.stringify([target.database ?? null, target.schema ?? null, target.name])}`;
}

/** `schema.name` for a table of another scope; a table of this scope keeps its bare name. */
function externalLabel(target: TableRef, scope: ObjectScope): string {
  const parts: string[] = [];
  if (target.database !== undefined && target.database !== scope.database) {
    parts.push(target.database);
  }
  if (target.schema !== undefined && target.schema !== scope.schema) {
    parts.push(target.schema);
  }
  return [...parts, target.name].join('.');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DbError('cancelled', msg('Reading the diagram was cancelled'));
  }
}

// What a schema holds, read for a comparison (V8.3): each table as the designer sees
// it, and the definition of every view, routine, trigger, sequence and event.

import { DbError, isDbError } from '../../core/errors';
import type {
  ListedObjectKind,
  ObjectRef,
  ObjectScope,
  TableStructure,
} from '../../core/model/objects';
import type { MetadataReader } from '../../drivers/driver';
import { designFromStructure, type LoadedTable } from '../table-structure';
import { msg } from '../../core/user-message';

export interface TableSnapshot {
  readonly name: string;
  readonly structure: TableStructure;
  readonly loaded: LoadedTable;
}

export interface ObjectSnapshot {
  readonly ref: ObjectRef;
  /** The statements that create it, ready to run in another database. */
  readonly statements?: readonly string[];
  /** Why the definition could not be read (the server hides it from this user). */
  readonly hidden?: string;
}

export interface SchemaSnapshot {
  readonly scope: ObjectScope;
  readonly tables: readonly TableSnapshot[];
  /** Views first, then the other kinds in the order the driver lists them. */
  readonly objects: readonly ObjectSnapshot[];
}

export interface SnapshotOptions {
  /** Kinds besides tables and views the database has (`capabilities.objectKinds`). */
  readonly kinds: readonly ListedObjectKind[];
  /** Makes a definition load elsewhere (MySQL: without DEFINER). */
  readonly portable?: (sql: string) => string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export async function readSchemaSnapshot(
  metadata: MetadataReader,
  scope: ObjectScope,
  options: SnapshotOptions,
): Promise<SchemaSnapshot> {
  const relations = await metadata.listTables(scope);
  const listed: ObjectRef[] = relations
    .filter((relation) => relation.kind === 'view')
    .map((view) => ({
      ...scope,
      kind: 'view' as const,
      name: view.name,
      ...(view.materialized === true ? { materialized: true } : {}),
    }));
  for (const kind of options.kinds) {
    for (const object of await metadata.listObjects(scope, kind)) {
      listed.push({ ...scope, ...object });
    }
  }
  const baseTables = relations.filter((relation) => relation.kind === 'table');
  const total = baseTables.length + listed.length;
  let done = 0;
  const step = (): void => {
    done += 1;
    options.onProgress?.(done, total);
  };
  const tables: TableSnapshot[] = [];
  for (const table of baseTables) {
    throwIfAborted(options.signal);
    const ref = { ...scope, name: table.name };
    const structure = await metadata.describeTable(ref);
    tables.push({ name: table.name, structure, loaded: designFromStructure(ref, structure) });
    step();
  }
  const portable = options.portable ?? ((sql: string) => sql);
  const objects: ObjectSnapshot[] = [];
  for (const ref of listed) {
    throwIfAborted(options.signal);
    try {
      const statements = await metadata.getDefinition(ref);
      objects.push({ ref, statements: statements.map(portable) });
    } catch (error) {
      if (isDbError(error) && error.code === 'permission-denied') {
        objects.push({ ref, hidden: error.message });
      } else if (!(isDbError(error) && error.code === 'not-found')) {
        throw error;
      }
      // Dropped while the schema was read: as if it had never been there.
    }
    step();
  }
  return { scope, tables, objects };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DbError('cancelled', msg('Reading the schema was cancelled'));
  }
}

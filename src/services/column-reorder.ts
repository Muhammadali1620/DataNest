// Moving a column one place (D116): where the database can do it, the usual ALTER (or a
// SQLite rebuild) as an action to confirm; where it cannot, a rebuild script for the user
// to read, with everything that depends on the table found first.

import { DbError } from '../core/errors';
import type { ObjectScope, TableRef } from '../core/model/objects';
import { msg } from '../core/user-message';
import type { Driver, MetadataReader } from '../drivers/driver';
import { canReorderColumns } from '../shared/table-design';
import { planColumnMove } from './column-move';
import {
  type MoveDirection,
  REBUILD_DRIVERS,
  type ReferencingKey,
  rebuildReorderScript,
  type TriggerScript,
} from './column-rebuild';
import type { SchemaAction } from './schema-actions';
import { triggerRef } from './table-checks';

/** Tables searched for foreign keys that point at the moved one; a schema has fewer. */
export const MAX_SEARCHED_TABLES = 400;

const BATCH = 8;

export type ReorderPlan =
  | { readonly kind: 'action'; readonly action: Extract<SchemaAction, { kind: 'alterTable' }> }
  | { readonly kind: 'script'; readonly sql: string };

type Reader = Pick<
  MetadataReader,
  'listTables' | 'describeTable' | 'listObjects' | 'getDefinition'
>;

/** True where the buttons make sense: the column can move by ALTER or by a rebuild script. */
export function canMoveColumns(driver: Driver['id']): boolean {
  return canReorderColumns(driver) || REBUILD_DRIVERS.has(driver);
}

export function scopeOfTable(table: TableRef): ObjectScope {
  return {
    ...(table.database === undefined ? {} : { database: table.database }),
    ...(table.schema === undefined ? {} : { schema: table.schema }),
  };
}

/** Foreign keys of other tables of the scope that point at `table`. */
export async function findReferencingKeys(
  reader: Pick<MetadataReader, 'listTables' | 'describeTable'>,
  table: TableRef,
): Promise<{ keys: ReferencingKey[]; checked: number | undefined }> {
  const scope = scopeOfTable(table);
  const all = (await reader.listTables(scope)).filter(
    (candidate) => candidate.kind === 'table' && candidate.name !== table.name,
  );
  const searched = all.slice(0, MAX_SEARCHED_TABLES);
  const keys: ReferencingKey[] = [];
  for (let at = 0; at < searched.length; at += BATCH) {
    const batch = searched.slice(at, at + BATCH);
    const described = await Promise.all(
      batch.map(async (other) => {
        const ref: TableRef = { ...scope, name: other.name };
        return { ref, structure: await reader.describeTable(ref) };
      }),
    );
    for (const { ref, structure } of described) {
      for (const key of structure.foreignKeys) {
        const there = key.target.schema ?? ref.schema;
        if (key.target.name === table.name && there === table.schema) {
          keys.push({ table: ref, key });
        }
      }
    }
  }
  return { keys, checked: all.length > searched.length ? searched.length : undefined };
}

async function triggersOf(reader: Reader, table: TableRef): Promise<TriggerScript[]> {
  const found = await reader.listObjects(scopeOfTable(table), 'trigger');
  const own = found.filter((object) => object.table === table.name);
  return await Promise.all(
    own.map(async (object) => ({
      name: object.name,
      statements: await reader.getDefinition(triggerRef(table, object.name)),
    })),
  );
}

/**
 * What moving `column` takes: an action where the database moves columns itself, a
 * script where the table has to be rebuilt; undefined when the column is at the edge.
 */
export async function planColumnReorder(
  reader: Reader,
  driver: Pick<Driver, 'id' | 'dialect'>,
  table: TableRef,
  column: string,
  direction: MoveDirection,
): Promise<ReorderPlan | undefined> {
  const structure = await reader.describeTable(table);
  if (canReorderColumns(driver.id)) {
    const action = planColumnMove(table, structure, column, direction);
    return action === undefined ? undefined : { kind: 'action', action };
  }
  if (!REBUILD_DRIVERS.has(driver.id)) {
    throw new DbError('unsupported', msg('This database cannot move a column'));
  }
  const [{ keys, checked }, triggers] = await Promise.all([
    findReferencingKeys(reader, table),
    triggersOf(reader, table),
  ]);
  const sql = rebuildReorderScript({
    driver: driver.id,
    dialect: driver.dialect,
    table,
    structure,
    column,
    direction,
    referencing: keys,
    triggers,
    ...(checked === undefined ? {} : { checkedTables: checked }),
  });
  return sql === undefined ? undefined : { kind: 'script', sql };
}

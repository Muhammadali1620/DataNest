// Every object of a connection, for the global object search: tables and views of
// each database or schema the user can see, and the routines, sequences and events
// the driver lists. Read through the metadata cache, so a second search is instant.

import type { ObjectKind, ObjectScope } from '../core/model/objects';
import { withoutSystemDatabases, withoutSystemSchemas } from '../core/model/system-objects';
import type { MetadataReader } from '../drivers/driver';
import { browseSession } from './browse-session';
import type { ConnectionManager } from './connection-manager';
import type { ConnectionStore } from './connection-store';
import type { MetadataCache } from './metadata-cache';

export interface IndexedObject extends ObjectScope {
  readonly connectionId: string;
  readonly kind: ObjectKind;
  readonly name: string;
  readonly signature?: string;
  readonly table?: string;
  readonly materialized?: boolean;
}

/** Search stops collecting past this many objects per connection. */
export const MAX_OBJECTS_PER_CONNECTION = 20_000;

export interface ObjectIndexDeps {
  readonly manager: Pick<ConnectionManager, 'acquire' | 'driverOf'>;
  readonly store: Pick<ConnectionStore, 'get'>;
  readonly cache: Pick<MetadataCache, 'wrap'>;
  /** `datanest.showSystemObjects`: whether the server's own databases count. */
  readonly showSystemObjects: () => boolean;
}

export async function indexConnection(
  deps: ObjectIndexDeps,
  connectionId: string,
): Promise<IndexedObject[]> {
  const config = deps.store.get(connectionId);
  if (config === undefined) {
    return [];
  }
  const driver = await deps.manager.driverOf(connectionId);
  const { capabilities } = driver;
  const reader = async (database?: string): Promise<MetadataReader> =>
    deps.cache.wrap(
      connectionId,
      (await browseSession(deps.manager, connectionId, database)).metadata,
    );
  const system = !deps.showSystemObjects();

  const scopes: ObjectScope[] = [];
  if (!capabilities.databases) {
    scopes.push({});
  } else {
    const listed = await (await reader()).listDatabases();
    const visible = system ? withoutSystemDatabases(config.driver, listed) : listed;
    // A server whose sessions see one database each (PostgreSQL) is searched in the
    // database the connection opens, rather than connecting to every database.
    const databases =
      capabilities.databaseScopedSessions && config.database !== undefined
        ? [config.database]
        : visible;
    for (const database of databases) {
      if (!capabilities.schemas) {
        scopes.push({ database });
        continue;
      }
      const schemas = await (await reader(database)).listSchemas(database);
      for (const schema of system ? withoutSystemSchemas(config.driver, schemas) : schemas) {
        scopes.push({ database, schema });
      }
    }
  }

  const found: IndexedObject[] = [];
  for (const scope of scopes) {
    if (found.length >= MAX_OBJECTS_PER_CONNECTION) {
      break;
    }
    const metadata = await reader(scope.database);
    for (const table of await metadata.listTables(scope)) {
      found.push({
        connectionId,
        ...scope,
        kind: table.kind,
        name: table.name,
        ...(table.materialized === true ? { materialized: true } : {}),
      });
    }
    for (const kind of capabilities.objectKinds) {
      for (const object of await metadata.listObjects(scope, kind)) {
        found.push({
          connectionId,
          ...scope,
          kind,
          name: object.name,
          ...(object.signature === undefined ? {} : { signature: object.signature }),
          ...(object.table === undefined ? {} : { table: object.table }),
        });
      }
    }
  }
  return found.slice(0, MAX_OBJECTS_PER_CONNECTION);
}

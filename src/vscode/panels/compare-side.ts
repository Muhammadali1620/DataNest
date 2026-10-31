// One side of a schema comparison: the connection and scope, and how to read its
// schema. Shared by the compare command and the Manager page's Structure Sync.

import type { ObjectScope } from '../../core/model/objects';
import { browseSession } from '../../services/browse-session';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import { readSchemaSnapshot } from '../../services/schema-compare/snapshot';
import { scopeLabel } from '../tree/compare-target';
import type { CompareSide } from './schema-compare-model';

export interface CompareSideDeps {
  readonly store: Pick<ConnectionStore, 'get'>;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire'>;
  readonly cache: Pick<MetadataCache, 'wrap'>;
}

export async function compareSideOf(
  deps: CompareSideDeps,
  connectionId: string,
  scope: ObjectScope,
): Promise<CompareSide> {
  const driver = await deps.manager.driverOf(connectionId);
  const name = deps.store.get(connectionId)?.name ?? connectionId;
  return {
    connectionId,
    label: scopeLabel(name, scope),
    scope,
    read: async (options) =>
      await readSchemaSnapshot(
        deps.cache.wrap(
          connectionId,
          (await browseSession(deps.manager, connectionId, scope.database)).metadata,
        ),
        scope,
        {
          kinds: driver.capabilities.objectKinds,
          ...(driver.dialect.dump.portable === undefined
            ? {}
            : { portable: driver.dialect.dump.portable }),
          ...options,
        },
      ),
  };
}

// "Compare Schemas…" (V8.3): the clicked database or schema (or one picked from the
// palette) is the source, the model to follow; the target, the schema to change, is
// picked among the connections of the same kind of database.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ObjectScope } from '../core/model/objects';
import { browseSession } from '../services/browse-session';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import type { MetadataCache } from '../services/metadata-cache';
import { readSchemaSnapshot } from '../services/schema-compare/snapshot';
import { describeTarget } from '../shared/connection';
import { pickConnection, pickScope } from './connection-pick';
import { type CompareSide, SchemaCompareModel } from './panels/schema-compare-model';
import { SchemaComparePanel } from './panels/schema-compare-panel';
import { compareStartOf, scopeLabel } from './tree/compare-target';
import { isTreeNode } from './tree/nodes';

export interface SchemaCompareCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire'>;
  readonly cache: MetadataCache;
  /** Opens SQL in a new editor bound to the connection and database. */
  readonly openEditor: (
    binding: { connectionId: string; database?: string },
    sql: string,
  ) => Promise<unknown>;
  readonly logger: Logger;
}

export function schemaCompareCommandHandlers(deps: SchemaCompareCommandDeps): {
  compareSchemas: (target?: unknown) => Promise<void>;
} {
  const side = async (connectionId: string, scope: ObjectScope): Promise<CompareSide> => {
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
  };

  const compareSchemas = async (target?: unknown): Promise<void> => {
    const start = isTreeNode(target)
      ? compareStartOf(target)
      : await (async () => {
          const id = await pickConnection(
            deps.store,
            vscode.l10n.t('Pick the source: the schema to follow'),
          );
          return id === undefined ? undefined : { connectionId: id, scope: undefined };
        })();
    if (start === undefined) {
      return;
    }
    const sourceScope = await pickScope(
      deps.manager,
      start.connectionId,
      start.scope,
      vscode.l10n.t('Pick the source schema'),
    );
    if (sourceScope === undefined) {
      return;
    }
    const source = deps.store.get(start.connectionId);
    if (source === undefined) {
      return;
    }
    const candidates = deps.store.list().filter((config) => config.driver === source.driver);
    const picked = await vscode.window.showQuickPick(
      candidates.map((config) => ({
        label: config.name,
        description: describeTarget(config),
        id: config.id,
      })),
      { placeHolder: vscode.l10n.t('Pick the target: the schema the script will change') },
    );
    if (picked === undefined) {
      return;
    }
    const targetScope = await pickScope(
      deps.manager,
      picked.id,
      undefined,
      vscode.l10n.t('Pick the target schema'),
    );
    if (targetScope === undefined) {
      return;
    }
    if (
      picked.id === start.connectionId &&
      JSON.stringify(targetScope) === JSON.stringify(sourceScope)
    ) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick another database or schema to compare with'),
      );
      return;
    }
    const driver = await deps.manager.driverOf(start.connectionId);
    const sourceSide = await side(start.connectionId, sourceScope);
    const targetSide = await side(picked.id, targetScope);
    const connections = { source: start.connectionId, target: picked.id };
    SchemaComparePanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      key: JSON.stringify([connections.source, sourceScope, connections.target, targetScope]),
      title: vscode.l10n.t('Compare {0} → {1}', sourceSide.label, targetSide.label),
      model: new SchemaCompareModel({
        source: sourceSide,
        target: targetSide,
        dialect: driver.dialect,
        driver: driver.id,
      }),
      invalidate: () => {
        deps.cache.invalidate(connections.source);
        deps.cache.invalidate(connections.target);
      },
      openScript: async (text, side) => {
        const { connectionId, scope } = side;
        await deps.openEditor(
          scope.database === undefined
            ? { connectionId }
            : { connectionId, database: scope.database },
          text,
        );
      },
    });
  };
  return { compareSchemas };
}

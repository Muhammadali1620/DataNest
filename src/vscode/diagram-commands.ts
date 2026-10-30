// "Show ER Diagram" (V8.1): from a database, schema, the Tables folder, chosen tables
// or the palette — the scope is asked for when the click does not tell it.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ObjectScope } from '../core/model/objects';
import { browseSession } from '../services/browse-session';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import type { MetadataCache } from '../services/metadata-cache';
import { pickConnection, pickScope } from './connection-pick';
import { ErDiagramModel } from './panels/er-diagram-model';
import { ErDiagramPanel } from './panels/er-diagram-panel';
import { type DiagramStart, diagramStartOf, diagramTitle } from './tree/diagram-target';
import { isTreeNode, type TableNode, type TreeNode } from './tree/nodes';

export interface DiagramCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire'>;
  readonly cache: MetadataCache;
  readonly openTable: (node: TableNode) => Promise<void>;
  readonly logger: Logger;
}

export function diagramCommandHandlers(deps: DiagramCommandDeps): {
  showErDiagram: (target?: unknown, selection?: readonly TreeNode[]) => Promise<void>;
} {
  const showErDiagram = async (
    target?: unknown,
    selection?: readonly TreeNode[],
  ): Promise<void> => {
    const start = await startOf(deps, target, selection);
    if (start === undefined) {
      return;
    }
    const scope = await pickScope(
      deps.manager,
      start.connectionId,
      start.scope,
      vscode.l10n.t('Pick the schema to draw'),
    );
    if (scope === undefined) {
      return;
    }
    const connectionName = deps.store.get(start.connectionId)?.name ?? start.connectionId;
    const title = diagramTitle(scope, start.tables, connectionName);
    const { connectionId } = start;
    ErDiagramPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      key: JSON.stringify([
        connectionId,
        scope.database ?? '',
        scope.schema ?? '',
        start.tables ?? null,
      ]),
      title,
      model: new ErDiagramModel({
        metadata: async () =>
          deps.cache.wrap(
            connectionId,
            (await browseSession(deps.manager, connectionId, scope.database)).metadata,
          ),
        scope,
        ...(start.tables === undefined ? {} : { tables: start.tables }),
        scopeLabel: title,
        connectionName,
      }),
      invalidate: () => {
        deps.cache.invalidate(connectionId);
      },
      openTable: async (table) => {
        const tableScope: ObjectScope = {
          ...(table.database === undefined ? {} : { database: table.database }),
          ...(table.schema === undefined ? {} : { schema: table.schema }),
        };
        await deps.openTable({
          kind: 'table',
          connectionId,
          scope: tableScope,
          name: table.name,
          tableKind: 'table',
        });
      },
    });
  };
  return { showErDiagram };
}

async function startOf(
  deps: DiagramCommandDeps,
  target: unknown,
  selection: readonly TreeNode[] | undefined,
): Promise<DiagramStart | undefined> {
  if (isTreeNode(target)) {
    const start = diagramStartOf(target, selection);
    if (start === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a database, schema or tables in the DataNest view to draw'),
      );
    }
    return start;
  }
  const connectionId = await pickConnection(
    deps.store,
    vscode.l10n.t('Pick the connection to draw'),
  );
  return connectionId === undefined ? undefined : { connectionId, scope: undefined };
}

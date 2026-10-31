// "Manager" (V11.13): the page with the log, dashboard, processes, dump and structure
// sync of one connection. Opened from the tree, from a table page's bar or the palette;
// the old "Dump to SQL File…" opens it on the Dump section.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { FileSink } from '../services/file-sink';
import type { QueryHistory } from '../services/history';
import type { MetadataCache } from '../services/metadata-cache';
import type { SqlDumper } from '../services/sql-dump';
import { isSqlDriver } from '../shared/connection';
import type { ManagerSection } from '../shared/protocols/manager';
import { pickConnection } from './connection-pick';
import { ManagerModel, type ManagerStart } from './panels/manager-model';
import { ManagerPanel } from './panels/manager-panel';
import { ServerMonitorModel } from './panels/server-monitor-model';
import { managerTargetOf } from './tree/manager-target';
import { isTreeNode } from './tree/nodes';

export interface ManagerCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire' | 'release'>;
  readonly cache: MetadataCache;
  readonly history: QueryHistory;
  readonly dumper: SqlDumper;
  /** Opens SQL in a new editor bound to the connection and database. */
  readonly openEditor: (
    binding: { connectionId: string; database?: string },
    sql: string,
  ) => Promise<unknown>;
  readonly logger: Logger;
}

export function managerCommandHandlers(deps: ManagerCommandDeps): {
  open: (target?: unknown) => Promise<void>;
  openDump: (target?: unknown) => Promise<void>;
} {
  const show = async (target: unknown, section: ManagerSection | undefined): Promise<void> => {
    const found = managerTargetOf(target, isTreeNode, section);
    const connectionId =
      found?.connectionId ??
      (await pickConnection(deps.store, vscode.l10n.t('Pick the connection to manage')));
    if (connectionId === undefined) {
      return;
    }
    const config = deps.store.get(connectionId);
    const driverId = config?.driver;
    if (config === undefined || driverId === undefined || !isSqlDriver(driverId)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a SQL connection in the DataNest view to open its manager'),
      );
      return;
    }
    const start: ManagerStart = {
      ...(found?.database === undefined ? {} : { database: found.database }),
      ...(found?.schema === undefined ? {} : { schema: found.schema }),
      ...(found?.table === undefined ? {} : { table: found.table }),
      ...(found?.section === undefined ? {} : { section: found.section }),
    };
    const driver = await deps.manager.driverOf(connectionId);
    const owner = ConnectionManager.taskOwner(`manager-${connectionId}`);
    ManagerPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      connectionId,
      connectionName: config.name,
      production: config.production === true,
      start,
      model: new ManagerModel({
        connectionId,
        start,
        store: deps.store,
        manager: deps.manager,
        cache: deps.cache,
        history: deps.history,
        dumper: deps.dumper,
        openSink: async (path) => await FileSink.create(path),
      }),
      monitor: () =>
        new ServerMonitorModel({
          connectionName: config.name,
          driver: driverId,
          dialect: driver.dialect,
          readOnly: config.readOnly === true,
          session: async () => await deps.manager.acquire(owner, { connectionId }),
        }),
      release: async () => {
        await deps.manager.release(owner);
      },
      onHistoryChange: (listener) => deps.history.onDidChange(listener),
      invalidate: () => {
        deps.cache.invalidate(connectionId);
      },
      openScript: async (text, targetConnection, database) => {
        await deps.openEditor(
          database === undefined
            ? { connectionId: targetConnection }
            : { connectionId: targetConnection, database },
          text,
        );
      },
      folder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
  };
  return {
    open: async (target) => {
      await show(target, undefined);
    },
    openDump: async (target) => {
      await show(target, 'dump');
    },
  };
}

// "Server Monitor" (V8.5): from a SQL connection in the tree, its id, or the palette.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { isSqlDriver } from '../shared/connection';
import { pickConnection } from './connection-pick';
import { ServerMonitorModel } from './panels/server-monitor-model';
import { ServerMonitorPanel } from './panels/server-monitor-panel';
import { isTreeNode } from './tree/nodes';

export interface MonitorCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'acquire' | 'release'>;
  readonly logger: Logger;
}

export function monitorCommandHandlers(deps: MonitorCommandDeps): {
  showMonitor: (target?: unknown) => Promise<void>;
} {
  const showMonitor = async (target?: unknown): Promise<void> => {
    const connectionId =
      isTreeNode(target) && 'connectionId' in target
        ? target.connectionId
        : typeof target === 'string' && target !== ''
          ? target
          : await pickConnection(deps.store, vscode.l10n.t('Pick the server to monitor'));
    if (connectionId === undefined) {
      return;
    }
    const config = deps.store.get(connectionId);
    if (config === undefined || !isSqlDriver(config.driver)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a SQL connection in the DataNest view to monitor its server'),
      );
      return;
    }
    const driver = await deps.manager.driverOf(connectionId);
    const owner = ConnectionManager.taskOwner(`monitor-${connectionId}`);
    ServerMonitorPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      connectionId,
      connectionName: config.name,
      production: config.production === true,
      model: new ServerMonitorModel({
        connectionName: config.name,
        driver: config.driver,
        dialect: driver.dialect,
        readOnly: config.readOnly === true,
        session: async () => await deps.manager.acquire(owner, { connectionId }),
      }),
      release: async () => {
        await deps.manager.release(owner);
      },
    });
  };
  return { showMonitor };
}

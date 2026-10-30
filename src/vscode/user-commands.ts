// "Users and Privileges" (V8.6): from a SQL connection or database in the tree, a
// connection id, or the palette. Object privileges are read in the clicked database.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { isSqlDriver } from '../shared/connection';
import { pickConnection } from './connection-pick';
import { UserAdminModel } from './panels/user-admin-model';
import { UserAdminPanel } from './panels/user-admin-panel';
import { isTreeNode } from './tree/nodes';

export interface UserCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'acquire' | 'release'>;
  readonly openEditor: (
    binding: { connectionId: string; database?: string },
    sql: string,
  ) => Promise<unknown>;
  readonly logger: Logger;
}

export function userCommandHandlers(deps: UserCommandDeps): {
  showUsers: (target?: unknown) => Promise<void>;
} {
  const showUsers = async (target?: unknown): Promise<void> => {
    let connectionId: string | undefined;
    let database: string | undefined;
    if (isTreeNode(target) && 'connectionId' in target) {
      connectionId = target.connectionId;
      database = target.kind === 'database' ? target.database : undefined;
    } else if (typeof target === 'string' && target !== '') {
      connectionId = target;
    } else {
      connectionId = await pickConnection(
        deps.store,
        vscode.l10n.t('Pick the server whose users to manage'),
      );
    }
    if (connectionId === undefined) {
      return;
    }
    const config = deps.store.get(connectionId);
    if (config === undefined || !isSqlDriver(config.driver)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a SQL connection in the DataNest view to manage its users'),
      );
      return;
    }
    if (config.driver === 'sqlite') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('A SQLite file has no users: whoever can open the file can read it'),
      );
      return;
    }
    const driver = await deps.manager.driverOf(connectionId);
    const owner = ConnectionManager.taskOwner(`users-${connectionId}-${database ?? ''}`);
    const binding = database === undefined ? { connectionId } : { connectionId, database };
    UserAdminPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      key: JSON.stringify([connectionId, database ?? null]),
      title:
        database === undefined
          ? vscode.l10n.t('Users: {0}', config.name)
          : vscode.l10n.t('Users: {0} · {1}', config.name, database),
      connectionName: config.name,
      production: config.production === true,
      model: new UserAdminModel({
        connectionName: config.name,
        ...(database === undefined ? {} : { database }),
        driver: config.driver,
        dialect: driver.dialect,
        readOnly: config.readOnly === true,
        session: async () => await deps.manager.acquire(owner, binding),
      }),
      openEditor: async (sql) => {
        await deps.openEditor(binding, sql);
      },
      release: async () => {
        await deps.manager.release(owner);
      },
    });
  };
  return { showUsers };
}

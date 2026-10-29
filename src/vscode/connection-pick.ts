// Asking which connection, and which database of it, a command should work on.
// Shared by the SQL editors and the file tasks (run a script, dump, transfer).

import * as vscode from 'vscode';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { describeTarget } from '../shared/connection';

export async function pickConnection(
  store: Pick<ConnectionStore, 'list'>,
  placeHolder: string = vscode.l10n.t('Pick a connection'),
): Promise<string | undefined> {
  const items = store.list().map((config) => ({
    label: config.name,
    description: describeTarget(config),
    id: config.id,
  }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There are no saved connections yet'));
    return undefined;
  }
  const chosen = await vscode.window.showQuickPick(items, { placeHolder });
  return chosen?.id;
}

/**
 * A database of the connection; `undefined` means "whatever the connection itself
 * opens", which is also the answer for databases that are a single file.
 */
export async function pickDatabase(
  manager: Pick<ConnectionManager, 'driverOf' | 'connect'>,
  connectionId: string,
): Promise<string | undefined> {
  const driver = await manager.driverOf(connectionId);
  if (!driver.capabilities.databases) {
    return undefined;
  }
  const session = await manager.connect(connectionId);
  const databases = await session.metadata.listDatabases();
  if (databases.length === 0) {
    return undefined;
  }
  return await vscode.window.showQuickPick(databases, {
    placeHolder: vscode.l10n.t('Pick a database'),
  });
}

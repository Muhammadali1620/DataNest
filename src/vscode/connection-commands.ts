import * as vscode from 'vscode';
import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { describeTarget, type ConnectionConfig } from '../shared/connection';
import { ConnectionFormPanel } from './panels/connection-form-panel';
import { connectionIdOf } from './tree/nodes';
import type { CommandTarget } from './tree/tree-commands';

export interface ConnectionCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
}

export type ConnectionCommandName = 'add' | 'edit' | 'duplicate' | 'remove';

/**
 * Commands that work on saved connections. Each takes an optional id, so the tree
 * (V1.9) can pass the clicked item while the palette asks the user to pick one.
 */
export function connectionCommandHandlers(
  deps: ConnectionCommandDeps,
): Record<ConnectionCommandName, (target?: CommandTarget) => unknown> {
  const pick = async (placeholder: string): Promise<string | undefined> =>
    await pickConnection(deps.store, placeholder);

  return {
    add: () => ConnectionFormPanel.show(deps),

    edit: async (clicked?: CommandTarget) => {
      const target = connectionIdOf(clicked) ?? (await pick(vscode.l10n.t('Pick a connection')));
      if (target === undefined) {
        return undefined;
      }
      requireConnection(deps.store, target);
      return ConnectionFormPanel.show(deps, target);
    },

    duplicate: async (clicked?: CommandTarget) => {
      const target = connectionIdOf(clicked) ?? (await pick(vscode.l10n.t('Pick a connection')));
      if (target === undefined) {
        return undefined;
      }
      requireConnection(deps.store, target);
      const copy = await deps.store.duplicate(target);
      return ConnectionFormPanel.show(deps, copy.id);
    },

    remove: async (clicked?: CommandTarget) => {
      const target = connectionIdOf(clicked) ?? (await pick(vscode.l10n.t('Pick a connection')));
      if (target === undefined) {
        return undefined;
      }
      const config = requireConnection(deps.store, target);
      const confirm = vscode.l10n.t('Delete');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete the connection "{0}"?', config.name),
        { modal: true },
        confirm,
      );
      if (answer !== confirm) {
        return undefined;
      }
      await deps.manager.disconnect(target);
      await deps.store.remove(target);
      return undefined;
    },
  };
}

function requireConnection(store: ConnectionStore, id: string): ConnectionConfig {
  const config = store.get(id);
  if (!config) {
    throw new DbError('not-found', vscode.l10n.t('This connection no longer exists'));
  }
  return config;
}

/** Quick Pick over saved connections; `undefined` when the user dismisses it. */
async function pickConnection(
  store: ConnectionStore,
  placeHolder: string,
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

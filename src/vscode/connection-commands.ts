import * as vscode from 'vscode';
import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import type { ServerStore } from '../services/server-store';
import { PROJECT_FILE_PATH } from '../services/project-connections';
import { describeTarget, type ConnectionConfig } from '../shared/connection';
import { ConnectionFormPanel } from './panels/connection-form-panel';
import { connectionIdOf } from './tree/nodes';
import type { PluginConnectionHandlers } from './plugin-connection-commands';
import type { CommandTarget } from './tree/tree-commands';

export interface ConnectionCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  /** Saved SSH servers a tunnel can be filled from (V15.1). */
  readonly servers?: ServerStore;
  /** Connections of drivers that other extensions registered (V12.7). */
  readonly plugins?: PluginConnectionHandlers;
}

export type ConnectionCommandName = 'add' | 'edit' | 'duplicate' | 'remove' | 'disable' | 'enable';

/**
 * Commands that work on saved connections. Each takes an optional id, so the tree
 * (V1.9) can pass the clicked item while the palette asks the user to pick one.
 */
export function connectionCommandHandlers(
  deps: ConnectionCommandDeps,
): Record<ConnectionCommandName, (target?: CommandTarget) => unknown> {
  const pick = async (
    placeholder: string,
    accept: (config: ConnectionConfig) => boolean = () => true,
  ): Promise<string | undefined> => await pickConnection(deps.store, placeholder, accept);

  // Switching off closes the sessions first; switching on only lifts the ban.
  const switchTo = async (clicked: CommandTarget | undefined, disabled: boolean): Promise<void> => {
    const target =
      connectionIdOf(clicked) ??
      (await pick(
        disabled
          ? vscode.l10n.t('Pick a connection to disable')
          : vscode.l10n.t('Pick a connection to enable'),
        // A project connection lives in a file shared with the team: it stays on.
        (config) =>
          (config.disabled === true) !== disabled && deps.store.projectOf(config.id) === undefined,
      ));
    if (target === undefined) {
      return;
    }
    requireConnection(deps.store, target);
    if (disabled) {
      await deps.manager.disconnect(target);
    }
    await deps.store.setDisabled(target, disabled);
  };

  return {
    add: async () => {
      // With drivers from other extensions around, the user first says which kind of database.
      if (deps.plugins?.available() === true) {
        const own = vscode.l10n.t('Built-in databases');
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: own,
              description: vscode.l10n.t('MySQL, PostgreSQL, SQLite, …'),
              plugin: false,
            },
            {
              label: vscode.l10n.t('From another extension'),
              description: vscode.l10n.t('Databases that other extensions added'),
              plugin: true,
            },
          ],
          { placeHolder: vscode.l10n.t('What kind of database?') },
        );
        if (choice === undefined) {
          return undefined;
        }
        if (choice.plugin) {
          return await deps.plugins.add();
        }
      }
      return ConnectionFormPanel.show(deps);
    },

    edit: async (clicked?: CommandTarget) => {
      const target = connectionIdOf(clicked) ?? (await pick(vscode.l10n.t('Pick a connection')));
      if (target === undefined) {
        return undefined;
      }
      const config = requireConnection(deps.store, target);
      if (config.driver === 'plugin' && deps.plugins !== undefined) {
        return await deps.plugins.edit(target);
      }
      return ConnectionFormPanel.show(deps, target);
    },

    duplicate: async (clicked?: CommandTarget) => {
      const target = connectionIdOf(clicked) ?? (await pick(vscode.l10n.t('Pick a connection')));
      if (target === undefined) {
        return undefined;
      }
      requireConnection(deps.store, target);
      const copy = await deps.store.duplicate(target);
      if (copy.driver === 'plugin' && deps.plugins !== undefined) {
        return await deps.plugins.edit(copy.id);
      }
      return ConnectionFormPanel.show(deps, copy.id);
    },

    remove: async (clicked?: CommandTarget) => {
      const target = connectionIdOf(clicked) ?? (await pick(vscode.l10n.t('Pick a connection')));
      if (target === undefined) {
        return undefined;
      }
      const config = requireConnection(deps.store, target);
      const project = deps.store.projectOf(target);
      const confirm = vscode.l10n.t('Delete');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete the connection "{0}"?', config.name),
        {
          modal: true,
          ...(project === undefined
            ? {}
            : {
                detail: vscode.l10n.t(
                  'It is removed from {0} of "{1}", so everyone who uses the project loses it once the change is committed.',
                  PROJECT_FILE_PATH,
                  project.name,
                ),
              }),
        },
        confirm,
      );
      if (answer !== confirm) {
        return undefined;
      }
      await deps.manager.disconnect(target);
      await deps.store.remove(target);
      return undefined;
    },

    disable: async (clicked?: CommandTarget) => {
      await switchTo(clicked, true);
    },

    enable: async (clicked?: CommandTarget) => {
      await switchTo(clicked, false);
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
  accept: (config: ConnectionConfig) => boolean,
): Promise<string | undefined> {
  const items = store
    .list()
    .filter(accept)
    .map((config) => ({
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

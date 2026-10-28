import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import { CONNECTION_COLORS, type ConnectionColor } from '../../shared/connection';
import { COLOR_THEME_IDS } from './connection-look';
import { folderNameProblem } from './folder-names';
import { connectionIdOf, type TreeNode } from './nodes';
import type { CommandTarget } from './tree-commands';

export interface FolderCommandDeps {
  readonly store: ConnectionStore;
}

function problemText(problem: NonNullable<ReturnType<typeof folderNameProblem>>): string {
  switch (problem) {
    case 'empty':
      return vscode.l10n.t('Give the folder a name');
    case 'too-long':
      return vscode.l10n.t('The name is too long');
    case 'taken':
      return vscode.l10n.t('There is already a folder with this name');
  }
}

async function askFolderName(
  store: ConnectionStore,
  title: string,
  current?: string,
): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title,
    value: current ?? '',
    prompt: vscode.l10n.t('Folders group connections in the tree; drag connections into them'),
    validateInput: (value) => {
      const problem = folderNameProblem(value, store.folders(), current);
      return problem === undefined ? undefined : problemText(problem);
    },
  });
  return name === undefined ? undefined : name.trim();
}

function folderOf(target: CommandTarget): string | undefined {
  return typeof target === 'object' && target.kind === 'connectionFolder'
    ? target.folder
    : undefined;
}

function colorLabel(color: ConnectionColor): string {
  switch (color) {
    case 'red':
      return vscode.l10n.t('Red');
    case 'orange':
      return vscode.l10n.t('Orange');
    case 'yellow':
      return vscode.l10n.t('Yellow');
    case 'green':
      return vscode.l10n.t('Green');
    case 'blue':
      return vscode.l10n.t('Blue');
    case 'purple':
      return vscode.l10n.t('Purple');
  }
}

/** Folder and color commands of the tree. */
export function folderCommandHandlers(deps: FolderCommandDeps): {
  createFolder: (target?: CommandTarget) => Promise<void>;
  renameFolder: (target?: CommandTarget) => Promise<void>;
  removeFolder: (target?: CommandTarget) => Promise<void>;
  moveToFolder: (target?: CommandTarget, selection?: readonly TreeNode[]) => Promise<void>;
  setColor: (target?: CommandTarget) => Promise<void>;
} {
  const { store } = deps;

  const createFolder = async (target?: CommandTarget): Promise<void> => {
    const name = await askFolderName(store, vscode.l10n.t('New Folder'));
    if (name === undefined) {
      return;
    }
    await store.createFolder(name);
    // Started from a connection: it goes into the new folder.
    const connectionId = connectionIdOf(target);
    if (connectionId !== undefined) {
      await store.moveConnections([connectionId], { folder: name });
    }
  };

  return {
    createFolder,

    renameFolder: async (target?: CommandTarget) => {
      const folder = folderOf(target) ?? (await pickFolder(store));
      if (folder === undefined) {
        return;
      }
      const name = await askFolderName(store, vscode.l10n.t('Rename Folder'), folder);
      if (name !== undefined && name !== folder) {
        await store.renameFolder(folder, name);
      }
    },

    removeFolder: async (target?: CommandTarget) => {
      const folder = folderOf(target) ?? (await pickFolder(store));
      if (folder === undefined) {
        return;
      }
      const inside = store.list().filter((config) => config.folder === folder).length;
      if (inside > 0) {
        const remove = vscode.l10n.t('Remove Folder');
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t('Remove the folder "{0}"?', folder),
          {
            modal: true,
            detail: vscode.l10n.t(
              'Its {0} connection(s) move to the top level; none is deleted.',
              inside,
            ),
          },
          remove,
        );
        if (answer !== remove) {
          return;
        }
      }
      await store.removeFolder(folder);
    },

    moveToFolder: async (target?: CommandTarget, selection?: readonly TreeNode[]) => {
      const ids = (selection ?? []).flatMap((node) =>
        node.kind === 'connection' ? [node.connectionId] : [],
      );
      const clicked = connectionIdOf(target);
      if (clicked !== undefined && !ids.includes(clicked)) {
        ids.push(clicked);
      }
      if (ids.length === 0) {
        return;
      }
      const current = ids.length === 1 ? store.get(ids[0] ?? '')?.folder : undefined;
      const NEW = Symbol('new');
      const TOP = Symbol('top');
      const items: (vscode.QuickPickItem & { value: string | typeof NEW | typeof TOP })[] = [
        ...store.folders().map((folder) => ({
          label: `$(folder) ${folder}`,
          value: folder,
          ...(folder === current ? { description: vscode.l10n.t('current') } : {}),
        })),
        { label: `$(list-flat) ${vscode.l10n.t('No folder (top level)')}`, value: TOP },
        { label: `$(new-folder) ${vscode.l10n.t('New Folder…')}`, value: NEW },
      ];
      const chosen = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t('Move to Folder'),
      });
      if (chosen === undefined) {
        return;
      }
      if (chosen.value === NEW) {
        const name = await askFolderName(store, vscode.l10n.t('New Folder'));
        if (name === undefined) {
          return;
        }
        await store.createFolder(name);
        await store.moveConnections(ids, { folder: name });
        return;
      }
      await store.moveConnections(ids, chosen.value === TOP ? {} : { folder: chosen.value });
    },

    setColor: async (target?: CommandTarget) => {
      const connectionId = connectionIdOf(target);
      if (connectionId === undefined) {
        return;
      }
      const current = store.get(connectionId)?.color;
      const items: (vscode.QuickPickItem & { value: ConnectionColor | undefined })[] = [
        ...CONNECTION_COLORS.map((color) => ({
          label: colorLabel(color),
          iconPath: new vscode.ThemeIcon(
            'circle-filled',
            new vscode.ThemeColor(COLOR_THEME_IDS[color]),
          ),
          value: color,
          ...(color === current ? { description: vscode.l10n.t('current') } : {}),
        })),
        {
          label: vscode.l10n.t('No color'),
          iconPath: new vscode.ThemeIcon('circle-outline'),
          value: undefined,
        },
      ];
      const chosen = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t('Connection Color'),
      });
      if (chosen !== undefined) {
        await store.setColor(connectionId, chosen.value);
      }
    },
  };
}

async function pickFolder(store: ConnectionStore): Promise<string | undefined> {
  const folders = store.folders();
  if (folders.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There are no folders yet'));
    return undefined;
  }
  return await vscode.window.showQuickPick(folders, { title: vscode.l10n.t('Pick a folder') });
}

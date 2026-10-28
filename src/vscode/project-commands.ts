import * as vscode from 'vscode';
import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { PROJECT_FILE_PATH, type ProjectFolder } from '../services/project-connections';
import { writeConnectionFile } from '../shared/connection-file';
import { projectFileUri } from './project-files';
import { connectionIdOf } from './tree/nodes';
import type { CommandTarget } from './tree/tree-commands';

export interface ProjectCommandDeps {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
}

/** Moves connections between the user's list and the project file, and opens that file. */
export function projectCommandHandlers(deps: ProjectCommandDeps): {
  moveToProject: (target?: CommandTarget) => Promise<void>;
  moveToUser: (target?: CommandTarget) => Promise<void>;
  openFile: (target?: CommandTarget) => Promise<void>;
} {
  const { store, manager } = deps;

  const moveToProject = async (target?: CommandTarget): Promise<void> => {
    const id = connectionIdOf(target) ?? (await pickConnection(store, false));
    const config = id === undefined ? undefined : store.get(id);
    if (id === undefined || config === undefined) {
      return;
    }
    if (store.projectOf(id) !== undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('"{0}" is already a project connection', config.name),
      );
      return;
    }
    const folder = await pickFolder(store.projectFolders());
    if (folder === undefined) {
      return;
    }
    const move = vscode.l10n.t('Move');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Move "{0}" to {1} of "{2}"?', config.name, PROJECT_FILE_PATH, folder.name),
      {
        modal: true,
        detail: vscode.l10n.t(
          'Everyone who opens the project will see this connection once the file is committed. The password is not written there: it stays on this computer.',
        ),
      },
      move,
    );
    if (answer !== move) {
      return;
    }
    // Its sessions belong to the old id; the moved connection has a new one.
    await manager.disconnect(id);
    const moved = await store.moveToProject(id, folder.key);
    deps.logger.info(`Moved "${moved.name}" to the project file of ${folder.name}`);
    const open = vscode.l10n.t('Open File');
    const next = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        '"{0}" is in {1} now. Commit the file to share it.',
        moved.name,
        PROJECT_FILE_PATH,
      ),
      open,
    );
    if (next === open) {
      await vscode.window.showTextDocument(projectFileUri(folder));
    }
  };

  const moveToUser = async (target?: CommandTarget): Promise<void> => {
    const id = connectionIdOf(target) ?? (await pickConnection(store, true));
    const config = id === undefined ? undefined : store.get(id);
    const folder = id === undefined ? undefined : store.projectOf(id);
    if (id === undefined || config === undefined) {
      return;
    }
    if (folder === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('"{0}" is already one of your connections', config.name),
      );
      return;
    }
    const move = vscode.l10n.t('Move');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Move "{0}" out of {1}?', config.name, PROJECT_FILE_PATH),
      {
        modal: true,
        detail: vscode.l10n.t(
          'It is removed from the project file, so others lose it after the change is committed, and stays on this computer as one of your connections.',
        ),
      },
      move,
    );
    if (answer !== move) {
      return;
    }
    await manager.disconnect(id);
    const moved = await store.moveToUser(id);
    deps.logger.info(`Moved "${moved.name}" out of the project file of ${folder.name}`);
  };

  const openFile = async (target?: CommandTarget): Promise<void> => {
    const folders = workspaceFolders();
    const clicked =
      typeof target === 'object' && target.kind === 'project'
        ? folders.find((folder) => folder.key === target.key)
        : undefined;
    const folder = clicked ?? (await pickFolder(folders));
    if (folder === undefined) {
      return;
    }
    const uri = projectFileUri(folder);
    if (!(await exists(uri))) {
      // A file to start from: the editor then offers completion from our JSON schema.
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(writeConnectionFile({ connections: [] })),
      );
    }
    await vscode.window.showTextDocument(uri);
  };

  return { moveToProject, moveToUser, openFile };
}

function workspaceFolders(): ProjectFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    key: folder.uri.toString(),
    name: folder.name,
    root: folder.uri.fsPath,
  }));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return false;
    }
    throw error;
  }
}

/** The only folder, or the one the user picks; a message when there is none. */
async function pickFolder(folders: readonly ProjectFolder[]): Promise<ProjectFolder | undefined> {
  if (folders.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.workspace.isTrusted
        ? vscode.l10n.t('Open a folder to keep connections in its project file')
        : vscode.l10n.t('Trust this workspace to keep connections in its project file'),
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const chosen = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.root, folder })),
    { placeHolder: vscode.l10n.t('Pick the workspace folder') },
  );
  return chosen?.folder;
}

/** Quick Pick over the user's own connections, or over the project's. */
async function pickConnection(
  store: ConnectionStore,
  project: boolean,
): Promise<string | undefined> {
  const items = store
    .list()
    .filter((config) => (store.projectOf(config.id) !== undefined) === project)
    .map((config) => ({ label: config.name, id: config.id }));
  if (items.length === 0) {
    throw new DbError(
      'not-found',
      project
        ? vscode.l10n.t('There are no project connections')
        : vscode.l10n.t('There are no saved connections yet'),
    );
  }
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Pick a connection'),
  });
  return chosen?.id;
}

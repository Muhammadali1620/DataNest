// "Open in DataNest" (V10.2.3) on a SQLite file in the Explorer, or picked from the
// Command Palette: the file's connection — found or made — connected and shown.

import * as vscode from 'vscode';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import {
  connectionForFile,
  connectionOfFile,
  SQLITE_FILE_EXTENSIONS,
} from '../services/sqlite-files';
import type { TreeNode } from './tree/nodes';

export interface SqliteFileCommandDeps {
  readonly store: ConnectionStore;
  readonly manager: Pick<ConnectionManager, 'connect'>;
  readonly treeView: vscode.TreeView<TreeNode>;
}

export function openSqliteFileCommand(
  deps: SqliteFileCommandDeps,
): (target?: unknown) => Promise<void> {
  return async (target?: unknown) => {
    const uri =
      target instanceof vscode.Uri
        ? target
        : (
            await vscode.window.showOpenDialog({
              canSelectMany: false,
              title: vscode.l10n.t('Open a SQLite Database'),
              filters: {
                [vscode.l10n.t('SQLite databases')]: SQLITE_FILE_EXTENSIONS.map((extension) =>
                  extension.slice(1),
                ),
                [vscode.l10n.t('All files')]: ['*'],
              },
            })
          )?.[0];
    if (uri === undefined) {
      return;
    }
    if (uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('DataNest opens SQLite files on this computer only'),
      );
      return;
    }
    // Windows and macOS file systems ignore case; Linux ones do not.
    const ignoreCase = process.platform !== 'linux';
    const existing = connectionOfFile(uri.fsPath, deps.store.list(), ignoreCase);
    const connectionId =
      existing?.id ?? (await deps.store.add(connectionForFile(uri.fsPath, deps.store.list()))).id;
    await deps.manager.connect(connectionId);
    await deps.treeView.reveal(
      { kind: 'connection', connectionId },
      { select: true, focus: true, expand: true },
    );
  };
}

// Cleaning up after e2e tests that use a project file in the scratch workspace.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * Closes the editors and the sessions of the project's connections, deletes its
 * file and databases, and makes DataNest forget the project at once — later tests
 * expect no saved connections, whenever the file watcher would notice.
 */
export async function forgetProject(
  root: string,
  connectionIds: readonly string[],
  databases: readonly string[],
): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // An open SQLite session holds its file, which Windows will not delete.
  for (const id of connectionIds) {
    await vscode.commands.executeCommand('datanest.connections.disconnect', id);
  }
  // The file, not the folder: on Windows the editor's file watcher keeps `.vscode` open,
  // and an empty folder means no project anyway.
  rmSync(join(root, '.vscode', 'datanest.json'), { force: true, maxRetries: 10, retryDelay: 100 });
  for (const database of databases) {
    try {
      rmSync(join(root, database), { force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // Windows keeps the file while the worker of the closed session exits; the e2e
      // build empties the folder before the next run, so it may stay behind.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM') {
        throw error;
      }
    }
  }
  await vscode.commands.executeCommand('datanest.tree.refresh');
}

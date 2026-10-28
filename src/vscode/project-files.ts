import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import {
  PROJECT_FILE_PATH,
  type ProjectConnections,
  type ProjectFiles,
  type ProjectFolder,
} from '../services/project-connections';

/** The project file of a workspace folder. */
export function projectFileUri(folder: ProjectFolder): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.parse(folder.key), ...PROJECT_FILE_PATH.split('/'));
}

/** Reads and writes project files through the editor, so remote workspaces work too. */
export function workspaceProjectFiles(): ProjectFiles {
  return {
    read: async (folder) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(projectFileUri(folder));
        return new TextDecoder().decode(bytes);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          return undefined;
        }
        throw error;
      }
    },
    write: async (folder, text) => {
      const uri = projectFileUri(folder);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    },
  };
}

function projectFolders(): ProjectFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    key: folder.uri.toString(),
    name: folder.name,
    root: folder.uri.fsPath,
  }));
}

/**
 * Keeps the project connections in step with the workspace: its folders, their
 * `.vscode/datanest.json` files on disk, and Workspace Trust — a file from an
 * untrusted repository is listed but its connections are not used (D53).
 */
export class ProjectFileWatcher implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];

  constructor(
    private readonly projects: ProjectConnections,
    private readonly logger: Logger,
  ) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.start();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.start();
      }),
    );
  }

  /** Reads every folder's file and watches them for changes. */
  async start(): Promise<void> {
    const folders = projectFolders();
    this.watch(folders);
    try {
      await this.projects.load(folders, vscode.workspace.isTrusted);
    } catch (error) {
      this.logger.warn('Could not read the project connections', error);
    }
  }

  dispose(): void {
    for (const disposable of [...this.watchers, ...this.subscriptions]) {
      disposable.dispose();
    }
    this.watchers = [];
    this.subscriptions.length = 0;
  }

  private watch(folders: readonly ProjectFolder[]): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = folders.map((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.parse(folder.key), PROJECT_FILE_PATH),
      );
      const reload = (): void => {
        this.projects.reload(folder.key).catch((error: unknown) => {
          this.logger.warn(`Could not read ${PROJECT_FILE_PATH} of ${folder.name}`, error);
        });
      };
      watcher.onDidCreate(reload);
      watcher.onDidChange(reload);
      watcher.onDidDelete(reload);
      return watcher;
    });
  }
}

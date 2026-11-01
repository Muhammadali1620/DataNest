// Queries kept in the project (V12.3): save the query being written to
// `.vscode/datanest-queries`, open one of them, delete one. The service is
// services/project-queries.ts; this file asks the questions and touches the editor.

import * as vscode from 'vscode';
import type { ConnectionStore } from '../services/connection-store';
import type { ProjectConnections, ProjectFolder } from '../services/project-connections';
import type { ProjectQueries } from '../services/project-queries';
import {
  PROJECT_QUERIES_PATH,
  PROJECT_QUERY_EXTENSION,
  type ProjectQuery,
  type ProjectQueryFiles,
  projectLocalId,
} from '../services/project-queries';
import { savedQueryNameProblem } from '../services/saved-queries';
import { DbError } from '../core/errors';
import { projectConnectionId } from '../services/project-connections';
import type { QueryEditors } from './editor/query-editor';
import { SQL_LANGUAGE_ID } from './editor/query-editor';

function folderUri(folder: ProjectFolder): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.parse(folder.key), ...PROJECT_QUERIES_PATH.split('/'));
}

function fileUri(folder: ProjectFolder, name: string): vscode.Uri {
  return vscode.Uri.joinPath(folderUri(folder), `${name}${PROJECT_QUERY_EXTENSION}`);
}

function isMissing(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

/** The files of the queries, through the editor's file system so remote workspaces work. */
export function workspaceProjectQueryFiles(): ProjectQueryFiles {
  return {
    list: async (folder) => {
      try {
        const entries = await vscode.workspace.fs.readDirectory(folderUri(folder));
        return entries
          .filter(
            ([name, type]) =>
              type === vscode.FileType.File && name.toLowerCase().endsWith(PROJECT_QUERY_EXTENSION),
          )
          .map(([name]) => name.slice(0, -PROJECT_QUERY_EXTENSION.length));
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      }
    },
    read: async (folder, name) => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri(folder, name)));
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },
    write: async (folder, name, text) => {
      await vscode.workspace.fs.createDirectory(folderUri(folder));
      await vscode.workspace.fs.writeFile(fileUri(folder, name), new TextEncoder().encode(text));
    },
    remove: async (folder, name) => {
      await vscode.workspace.fs.delete(fileUri(folder, name));
    },
  };
}

export interface ProjectQueryDeps {
  readonly queries: ProjectQueries;
  readonly projects: Pick<ProjectConnections, 'folders' | 'writableFolders' | 'folderOf'>;
  readonly store: Pick<ConnectionStore, 'get'>;
  readonly editors: Pick<QueryEditors, 'bindings'>;
}

interface QueryItem extends vscode.QuickPickItem {
  readonly query: ProjectQuery;
}

/** Which folder to use: the only one, or the one the user picks. */
async function pickFolder(
  folders: readonly ProjectFolder[],
  placeHolder: string,
): Promise<ProjectFolder | undefined> {
  if (folders.length <= 1) {
    return folders[0];
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, folder })),
    { placeHolder },
  );
  return picked?.folder;
}

export function projectQueryHandlers(deps: ProjectQueryDeps): {
  save: () => Promise<void>;
  open: () => Promise<void>;
  remove: () => Promise<void>;
} {
  const pick = async (placeHolder: string): Promise<ProjectQuery | undefined> => {
    const queries = await deps.queries.list(deps.projects.folders());
    if (queries.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'There are no queries in the project yet: save one with "Save Query to Project…"',
        ),
      );
      return undefined;
    }
    const many = new Set(queries.map((query) => query.folder.key)).size > 1;
    const items: QueryItem[] = queries.map((query) => ({
      label: query.name,
      description: [many ? query.folder.name : undefined, query.place.connection]
        .filter((part) => part !== undefined)
        .join(' · '),
      query,
    }));
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))
      ?.query;
  };

  const save = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== SQL_LANGUAGE_ID) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
      );
      return;
    }
    const folders = deps.projects.writableFolders();
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a trusted folder first: project queries are saved in it'),
      );
      return;
    }
    const selected = editor.document.getText(editor.selection);
    const sql = selected.trim() === '' ? editor.document.getText() : selected;
    if (sql.trim() === '') {
      void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to run'));
      return;
    }
    const folder = await pickFolder(folders, vscode.l10n.t('Pick the folder to save the query in'));
    if (folder === undefined) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: vscode.l10n.t('Save Query to Project'),
      prompt: vscode.l10n.t('Name of the query, saved in {0}', PROJECT_QUERIES_PATH),
      validateInput: (value) => savedQueryNameProblem(value.replace(/\.sql$/iu, '')),
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }
    if (await deps.queries.exists(folder, name)) {
      const replace = vscode.l10n.t('Replace');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('A query named "{0}" already exists in the project', name),
        { modal: true },
        replace,
      );
      if (answer !== replace) {
        return;
      }
    }
    const binding = deps.editors.bindings.get(editor.document.uri.toString());
    const local = binding === undefined ? undefined : projectLocalId(folder, binding.connectionId);
    try {
      const saved = await deps.queries.save(folder, name, sql, {
        ...(local === undefined ? {} : { connection: local }),
        ...(binding?.database === undefined || local === undefined
          ? {}
          : { database: binding.database }),
      });
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Saved in {0}/{1}.sql', PROJECT_QUERIES_PATH, saved),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof DbError ? error.message : vscode.l10n.t('Could not save the query'),
      );
    }
  };

  const open = async (): Promise<void> => {
    const query = await pick(vscode.l10n.t('Pick a query of the project'));
    if (query === undefined) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(fileUri(query.folder, query.name));
    if (query.place.connection !== undefined) {
      const id = projectConnectionId(query.folder.key, query.place.connection);
      if (deps.store.get(id) !== undefined) {
        deps.editors.bindings.bind(document.uri.toString(), {
          connectionId: id,
          ...(query.place.database === undefined ? {} : { database: query.place.database }),
        });
      }
    }
    await vscode.window.showTextDocument(document, { preview: false });
  };

  const remove = async (): Promise<void> => {
    const query = await pick(vscode.l10n.t('Pick the query to delete'));
    if (query === undefined) {
      return;
    }
    const confirm = vscode.l10n.t('Delete');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete the query "{0}" from the project?', query.name),
      { modal: true },
      confirm,
    );
    if (answer === confirm) {
      await deps.queries.remove(query.folder, query.name);
    }
  };

  return { save, open, remove };
}

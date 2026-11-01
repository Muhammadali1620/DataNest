// The editor's side of the notebook file (V12.1): what the file holds, as notebook data
// and back. The format and its checks are services/notebook-file.ts.

import * as vscode from 'vscode';
import {
  parseNotebook,
  serializeNotebook,
  type NotebookCellFile,
} from '../../services/notebook-file';
import { SQL_LANGUAGE_ID } from '../editor/query-editor';

/** What a notebook remembers about where it runs; written to the file on save. */
export interface NotebookMetadata {
  readonly connection?: string;
  readonly connectionName?: string;
  readonly database?: string;
}

const MARKDOWN = 'markdown';

export function metadataOf(source: object | undefined): NotebookMetadata {
  const metadata = source as Readonly<Record<string, unknown>> | undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const connection = text(metadata?.connection);
  const connectionName = text(metadata?.connectionName);
  const database = text(metadata?.database);
  return {
    ...(connection === undefined ? {} : { connection }),
    ...(connectionName === undefined ? {} : { connectionName }),
    ...(database === undefined ? {} : { database }),
  };
}

export class SqlNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const file = parseNotebook(new TextDecoder().decode(content));
    const cells =
      file.cells.length === 0
        ? [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', SQL_LANGUAGE_ID)]
        : file.cells.map((cell) =>
            cell.kind === 'markdown'
              ? new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, cell.source, MARKDOWN)
              : new vscode.NotebookCellData(
                  vscode.NotebookCellKind.Code,
                  cell.source,
                  SQL_LANGUAGE_ID,
                ),
          );
    const data = new vscode.NotebookData(cells);
    data.metadata = metadataOf(file);
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const cells: NotebookCellFile[] = data.cells.map((cell) => ({
      kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql',
      source: cell.value,
    }));
    return new TextEncoder().encode(serializeNotebook({ ...metadataOf(data.metadata), cells }));
  }
}

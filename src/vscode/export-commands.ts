// Writing data to a file (V2.9, V5.4). A result the grid holds whole is written from
// memory; a table view, a table from the tree, and a query cut by the row limit are
// read again in full and streamed to the file.

import { join } from 'node:path';
import * as vscode from 'vscode';
import { isDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { TableRef } from '../core/model/objects';
import { changingStatements } from '../core/sql/read-only';
import { splitStatements } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import { browseSession } from '../services/browse-session';
import type { ConnectionManager, SessionTarget } from '../services/connection-manager';
import { FileSink } from '../services/file-sink';
import { formatDuration } from '../services/history-format';
import {
  EXPORT_FORMATS,
  type ExportError,
  type ExportFormat,
  exportBytes,
  extensionOf,
  isExportFormat,
  suggestedFileName,
} from '../services/result-export';
import type { ResultStore } from '../services/result-store';
import type { StreamExporter } from '../services/stream-export';
import type { TableViewer } from '../services/table-view';
import { XlsxLimitError } from '../services/xlsx';
import { formatSize } from '../shared/byte-size';
import { dumpFileName } from './tree/dump-target';
import { isTreeNode, tableRefOf } from './tree/nodes';

export interface ExportCommandDeps {
  readonly results: ResultStore;
  readonly manager: Pick<ConnectionManager, 'acquire' | 'driverOf'>;
  readonly tables: Pick<TableViewer, 'fullQuery'>;
  readonly exporter: StreamExporter;
  readonly logger: Logger;
}

/** The progress notification is updated at most this often. */
const PROGRESS_INTERVAL_MS = 250;

/** What a streamed export reads and how the file names its rows. */
interface StreamSource {
  readonly target: SessionTarget;
  readonly sql: string;
  /** The table, for INSERT statements and the sheet name. */
  readonly table?: TableRef;
  readonly identity?: boolean;
  /** What the progress says it is exporting. */
  readonly label: string;
}

export function exportCommandHandlers(deps: ExportCommandDeps): {
  exportResult: (resultId: string, format: ExportFormat) => Promise<void>;
  exportTable: (target?: unknown) => Promise<void>;
} {
  /** Asks where to save; undefined when the user backs out. */
  const askFile = async (name: string, format: ExportFormat): Promise<vscode.Uri | undefined> => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Export Result'),
      defaultUri: vscode.Uri.file(folder === undefined ? name : join(folder, name)),
      filters: { [format.toUpperCase()]: [extensionOf(format)] },
    });
  };

  /** The SELECT of a table's columns that can be written back: computed ones are left out. */
  const tableSource = async (
    target: SessionTarget,
    table: TableRef,
    format: ExportFormat,
    full: (columns?: readonly string[]) => Promise<string>,
  ): Promise<StreamSource> => {
    const label = table.name;
    if (format !== 'sql') {
      return { target, sql: await full(), table, label };
    }
    const session = await browseSession(deps.manager, target.connectionId, table.database);
    const structure = await session.metadata.describeTable(table);
    const columns = structure.columns.filter((column) => !column.generated);
    return {
      target,
      sql: await full(columns.map((column) => column.name)),
      table: { ...(table.schema === undefined ? {} : { schema: table.schema }), name: table.name },
      identity: columns.some((column) => column.autoIncrement),
      label,
    };
  };

  const stream = async (source: StreamSource, format: ExportFormat, file: vscode.Uri) => {
    const sink = await FileSink.create(file.fsPath);
    try {
      const report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Exporting {0}', source.label),
          cancellable: true,
        },
        async (progress, token) => {
          const abort = new AbortController();
          const subscription = token.onCancellationRequested(() => {
            abort.abort();
          });
          let shownAt = 0;
          try {
            return await deps.exporter.export({
              target: source.target,
              sql: source.sql,
              format,
              sink,
              ...(source.table === undefined ? {} : { table: source.table }),
              ...(source.identity === true ? { identity: true } : {}),
              sheetName: source.label,
              signal: abort.signal,
              onProgress: (rows) => {
                const now = Date.now();
                if (now - shownAt >= PROGRESS_INTERVAL_MS) {
                  shownAt = now;
                  progress.report({ message: vscode.l10n.t('{0} rows', rows) });
                }
              },
            });
          } finally {
            subscription.dispose();
          }
        },
      );
      await sink.close();
      deps.logger.info(`Exported ${report.rows} rows to ${file.fsPath}`);
      const reveal = vscode.l10n.t('Show in Folder');
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Exported {0} rows ({1}) in {2}',
          report.rows,
          formatSize(sink.bytes),
          formatDuration(report.durationMs),
        ),
        reveal,
      );
      if (choice === reveal) {
        await vscode.commands.executeCommand('revealFileInOS', file);
      }
    } catch (error) {
      await sink.discard();
      if (isDbError(error) && error.code === 'cancelled') {
        void vscode.window.showInformationMessage(vscode.l10n.t('The export was cancelled'));
        return;
      }
      if (error instanceof XlsxLimitError) {
        void vscode.window.showWarningMessage(exportErrorMessage('too-large'));
        return;
      }
      throw error;
    }
  };

  const exportResult = async (resultId: string, format: ExportFormat): Promise<void> => {
    const summary = deps.results.get(resultId);
    const rows = deps.results.allRows(resultId);
    if (summary === undefined || rows === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This result is no longer available'),
      );
      return;
    }
    const origin = summary.origin?.target;
    // A table view holds one page; the export is the whole table as filtered and sorted.
    if (summary.page !== undefined && origin !== undefined) {
      const view = await deps.tables.fullQuery(summary.documentUri);
      if (view !== undefined) {
        const file = await askFile(
          dumpFileName(view.table.name, new Date()).replace(/\.sql$/u, `.${extensionOf(format)}`),
          format,
        );
        if (file === undefined) {
          return;
        }
        const source = await tableSource(view.target, view.table, format, async (columns) => {
          const query = await deps.tables.fullQuery(summary.documentUri, columns);
          return query?.sql ?? view.sql;
        });
        await stream(source, format, file);
        return;
      }
    }
    if (summary.truncated && origin !== undefined) {
      const choice = await askTruncated(summary.statement, rows.length, origin, deps);
      if (choice === undefined) {
        return;
      }
      if (choice === 'all') {
        const file = await askFile(suggestedFileName(summary.statement, format), format);
        if (file === undefined) {
          return;
        }
        const table = summary.edit?.editable === true ? { table: summary.edit.table } : {};
        await stream(
          { target: origin, sql: summary.statement, ...table, label: vscode.l10n.t('the result') },
          format,
          file,
        );
        return;
      }
    }
    const file = await askFile(suggestedFileName(summary.statement, format), format);
    if (file === undefined) {
      return;
    }
    const dialect =
      origin === undefined ? undefined : (await deps.manager.driverOf(origin.connectionId)).dialect;
    const outcome = exportBytes(
      { columns: summary.columns, rows, dialect, edit: summary.edit },
      format,
    );
    if (!outcome.ok) {
      void vscode.window.showWarningMessage(exportErrorMessage(outcome.error));
      return;
    }
    await vscode.workspace.fs.writeFile(file, outcome.data);
    deps.logger.info(`Exported ${rows.length} rows to ${file.fsPath}`);
    void vscode.window.showInformationMessage(vscode.l10n.t('Exported {0} rows', rows.length));
  };

  /** "Export Data…" on a table or view of the tree: every row, straight from the server. */
  const exportTable = async (target?: unknown): Promise<void> => {
    if (!isTreeNode(target) || target.kind !== 'table') {
      return;
    }
    const format = await vscode.window.showQuickPick([...EXPORT_FORMATS], {
      title: vscode.l10n.t('Export Data of {0}', target.name),
      placeHolder: vscode.l10n.t('Pick a format'),
    });
    if (format === undefined || !isExportFormat(format)) {
      return;
    }
    const table = tableRefOf(target);
    const file = await askFile(
      dumpFileName(target.name, new Date()).replace(/\.sql$/u, `.${extensionOf(format)}`),
      format,
    );
    if (file === undefined) {
      return;
    }
    const sessionTarget: SessionTarget =
      table.database === undefined
        ? { connectionId: target.connectionId }
        : { connectionId: target.connectionId, database: table.database };
    const { dialect } = await deps.manager.driverOf(target.connectionId);
    const source = await tableSource(sessionTarget, table, format, (columns) =>
      Promise.resolve(
        `SELECT ${
          columns === undefined
            ? '*'
            : columns.map((name) => dialect.quoteIdentifier(name)).join(', ')
        } FROM ${dialect.quoteTable(table)}`,
      ),
    );
    await stream(source, format, file);
  };

  return { exportResult, exportTable };
}

/**
 * The grid holds only the rows up to the limit. Reading all of them means running the
 * query again, which is offered only for a statement that changes nothing.
 */
async function askTruncated(
  statement: string,
  loaded: number,
  origin: SessionTarget,
  deps: Pick<ExportCommandDeps, 'manager'>,
): Promise<'all' | 'loaded' | undefined> {
  const driver = await deps.manager.driverOf(origin.connectionId);
  const statements = splitStatements(statement, driver.id);
  if (changingStatements(statements, syntaxOf(driver.id)).length > 0) {
    return 'loaded';
  }
  const all = vscode.l10n.t('All Rows');
  const loadedOnly = vscode.l10n.t('Only These {0} Rows', loaded);
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('The result holds only the first {0} rows. Export all of them?', loaded),
    {
      modal: true,
      detail: vscode.l10n.t('All rows: the query runs again and its rows go straight to the file.'),
    },
    all,
    loadedOnly,
  );
  return choice === all ? 'all' : choice === loadedOnly ? 'loaded' : undefined;
}

/** Why a result cannot be written in a format, in the user's words. */
export function exportErrorMessage(error: ExportError): string {
  return error === 'too-large'
    ? vscode.l10n.t('The result does not fit this format (Excel holds about a million rows)')
    : error === 'no-rows'
      ? vscode.l10n.t('There is nothing to export')
      : vscode.l10n.t('This format needs rows and writable columns; computed columns are skipped');
}

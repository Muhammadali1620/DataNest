// Filling a table from outside: "Import Data from File…" (V5.3) picks a CSV or JSON
// file for the import page; "Generate Test Data…" (V5.5) opens the generator page.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { TableRef } from '../core/model/objects';
import { browseSession } from '../services/browse-session';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { TableImporter } from '../services/import/table-import';
import type { MetadataCache } from '../services/metadata-cache';
import { readTextChunks } from '../services/text-file';
import { changeVerdict, policyOf } from '../services/write-policy';
import { DataImportModel } from './panels/data-import-model';
import { DataImportPanel } from './panels/data-import-panel';
import { TestDataModel } from './panels/test-data-model';
import { TestDataPanel } from './panels/test-data-panel';
import { isTreeNode, tableRefOf } from './tree/nodes';

export interface ImportCommandDeps {
  readonly extensionUri: vscode.Uri;
  /** Opens SQL in a new editor bound to the connection and database. */
  readonly openEditor: (
    binding: { connectionId: string; database?: string },
    sql: string,
  ) => Promise<unknown>;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly logger: Logger;
}

export function importCommandHandlers(deps: ImportCommandDeps): {
  importData: (target?: unknown) => Promise<void>;
  /** Imports into a table by reference, e.g. from the result page of its table view (V12.1). */
  importInto: (connectionId: string, table: TableRef) => Promise<void>;
  generateData: (target?: unknown) => Promise<void>;
} {
  const importer = new TableImporter({ manager: deps.manager, logger: deps.logger });
  const importData = async (target?: unknown): Promise<void> => {
    if (!isTreeNode(target) || target.kind !== 'table' || target.tableKind !== 'table') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a table in the DataNest view to import into'),
      );
      return;
    }
    await importInto(target.connectionId, tableRefOf(target));
  };
  const importInto = async (connectionId: string, table: TableRef): Promise<void> => {
    const policy = policyOf(deps.store.get(connectionId));
    if (changeVerdict(policy) === 'refuse') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('"{0}" is read-only: data cannot be imported into it.', policy.name),
      );
      return;
    }
    const chosen = await vscode.window.showOpenDialog({
      title: vscode.l10n.t('Import Data into {0}', table.name),
      canSelectMany: false,
      filters: {
        [vscode.l10n.t('CSV and JSON')]: ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson'],
        [vscode.l10n.t('All Files')]: ['*'],
      },
    });
    const file = chosen?.[0];
    if (file === undefined) {
      return;
    }
    const driver = await deps.manager.driverOf(connectionId);
    const session = await browseSession(deps.manager, connectionId, table.database);
    const structure = await session.metadata.describeTable(table);
    const size = (await vscode.workspace.fs.stat(file)).size;
    const model = new DataImportModel({
      target:
        table.database === undefined
          ? { connectionId }
          : { connectionId, database: table.database },
      table,
      driver: driver.id,
      transactional: driver.capabilities.transactions,
      file: file.fsPath,
      columns: structure.columns,
      readChunks: (path) => readTextChunks(path),
      importer,
    });
    await DataImportPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      model,
      tableLabel: [table.schema, table.name].filter((part) => part !== undefined).join('.'),
      file: file.fsPath,
      size,
      policy,
      onImported: () => {
        deps.cache.invalidate(connectionId);
      },
    });
  };
  /** "Generate Test Data…" on a table (V5.5). */
  const generateData = async (target?: unknown): Promise<void> => {
    if (!isTreeNode(target) || target.kind !== 'table' || target.tableKind !== 'table') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a table in the DataNest view to fill with test data'),
      );
      return;
    }
    const policy = policyOf(deps.store.get(target.connectionId));
    if (changeVerdict(policy) === 'refuse') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('"{0}" is read-only: data cannot be inserted.', policy.name),
      );
      return;
    }
    const table = tableRefOf(target);
    const driver = await deps.manager.driverOf(target.connectionId);
    const session = async () =>
      await browseSession(deps.manager, target.connectionId, table.database);
    const structure = await (await session()).metadata.describeTable(table);
    const sessionTarget =
      table.database === undefined
        ? { connectionId: target.connectionId }
        : { connectionId: target.connectionId, database: table.database };
    TestDataPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      model: new TestDataModel({
        target: sessionTarget,
        table,
        driver: driver.id,
        dialect: driver.dialect,
        structure,
        session,
        importer,
      }),
      tableLabel: [table.schema, table.name].filter((part) => part !== undefined).join('.'),
      policy,
      openSql: async (sql) => {
        await deps.openEditor(sessionTarget, sql);
      },
      onInserted: () => {
        deps.cache.invalidate(target.connectionId);
      },
      barView: { target: sessionTarget, table },
    });
  };

  return { importData, importInto, generateData };
}

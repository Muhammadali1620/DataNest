// "Import Data from File…" on a table (V5.3): pick a CSV or JSON file, then the
// import page takes over.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import { browseSession } from '../services/browse-session';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { TableImporter } from '../services/import/table-import';
import type { MetadataCache } from '../services/metadata-cache';
import { readTextChunks } from '../services/text-file';
import { changeVerdict, policyOf } from '../services/write-policy';
import { DataImportModel } from './panels/data-import-model';
import { DataImportPanel } from './panels/data-import-panel';
import { isTreeNode, tableRefOf } from './tree/nodes';

export interface ImportCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly logger: Logger;
}

export function importCommandHandlers(deps: ImportCommandDeps): {
  importData: (target?: unknown) => Promise<void>;
} {
  const importer = new TableImporter({ manager: deps.manager, logger: deps.logger });
  const importData = async (target?: unknown): Promise<void> => {
    if (!isTreeNode(target) || target.kind !== 'table' || target.tableKind !== 'table') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a table in the DataNest view to import into'),
      );
      return;
    }
    const policy = policyOf(deps.store.get(target.connectionId));
    if (changeVerdict(policy) === 'refuse') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('"{0}" is read-only: data cannot be imported into it.', policy.name),
      );
      return;
    }
    const chosen = await vscode.window.showOpenDialog({
      title: vscode.l10n.t('Import Data into {0}', target.name),
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
    const table = tableRefOf(target);
    const driver = await deps.manager.driverOf(target.connectionId);
    const session = await browseSession(deps.manager, target.connectionId, table.database);
    const structure = await session.metadata.describeTable(table);
    const size = (await vscode.workspace.fs.stat(file)).size;
    const model = new DataImportModel({
      target:
        table.database === undefined
          ? { connectionId: target.connectionId }
          : { connectionId: target.connectionId, database: table.database },
      table,
      driver: driver.id,
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
        deps.cache.invalidate(target.connectionId);
      },
    });
  };
  return { importData };
}

import * as vscode from 'vscode';
import { createBundleDriverLoader, DriverRegistry } from './drivers/registry';
import { ConnectionManager, type SessionTarget } from './services/connection-manager';
import { ConnectionStore } from './services/connection-store';
import { MetadataCache } from './services/metadata-cache';
import type { TableRef } from './core/model/objects';
import { CONTEXT_KEYS } from './vscode/command-ids';
import { registerCommands } from './vscode/commands';
import { createOutputLogger } from './vscode/logging';
import { QueryRunner } from './services/query-runner';
import {
  type ExportFormat,
  exportResult as exportResultText,
  extensionOf,
  suggestedFileName,
} from './services/result-export';
import { ResultEditor } from './services/result-editor';
import { ResultSaver } from './services/result-saver';
import { ResultStore } from './services/result-store';
import { TableViewer, tableDocumentUri } from './services/table-view';
import { QueryEditors } from './vscode/editor/query-editor';
import { SqlCompletionProvider, TRIGGER_CHARACTERS } from './vscode/editor/completion';
import { RunCodeLensProvider } from './vscode/editor/run-query';
import { ResultsPanel } from './vscode/panels/results-panel';
import { RunStatus } from './vscode/editor/run-status';
import { createSettings, readPageSize, readQueryTimeoutMs, readRowLimit } from './vscode/settings';
import { CONNECTIONS_VIEW_ID, ConnectionsTreeProvider } from './vscode/tree/connections-tree';
import type { TableNode } from './vscode/tree/nodes';

// The composition root: services are created and wired here, nowhere else (ARCHITECTURE.md §10).
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const { logger, channel, disposables } = createOutputLogger();
  context.subscriptions.push(...disposables);

  const store = new ConnectionStore({
    state: context.globalState,
    secrets: context.secrets,
    logger,
  });
  const drivers = new DriverRegistry({
    // Driver bundles sit next to the extension bundle and load on first use (§7).
    loader: createBundleDriverLoader(__filename),
    logger,
  });
  const manager = new ConnectionManager({ store, drivers, logger });
  context.subscriptions.push(manager);
  const cache = new MetadataCache({ logger });

  const editors = new QueryEditors({ store, manager, logger });
  context.subscriptions.push(editors);

  const results = new ResultStore();
  const runner = new QueryRunner({
    manager,
    results,
    cache,
    limits: { rowLimit: () => readRowLimit(), timeoutMs: () => readQueryTimeoutMs() },
    logger,
  });
  context.subscriptions.push(
    new RunStatus(runner),
    vscode.languages.registerCompletionItemProvider(
      { language: 'sql' },
      new SqlCompletionProvider({ editors, store, manager, cache, logger }),
      ...TRIGGER_CHARACTERS,
    ),
  );
  const tables = new TableViewer({
    manager,
    results,
    cache,
    limits: { pageSize: () => readPageSize() },
    logger,
  });

  /** Writes a result to a file the user picks; the whole result, not just a page. */
  const exportResult = async (resultId: string, format: ExportFormat): Promise<void> => {
    const summary = results.get(resultId);
    const rows = results.allRows(resultId);
    if (summary === undefined || rows === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This result is no longer available'),
      );
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Export Result'),
      defaultUri: vscode.Uri.file(suggestedFileName(summary.statement, format)),
      filters: { [format.toUpperCase()]: [extensionOf(format)] },
    });
    if (target === undefined) {
      return;
    }
    const text = exportResultText({ columns: summary.columns, rows }, format);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    logger.info(`Exported ${rows.length} rows to ${target.fsPath}`);
    void vscode.window.showInformationMessage(vscode.l10n.t('Exported {0} rows', rows.length));
  };

  const editor = new ResultEditor(results);
  const saver = new ResultSaver({
    manager,
    results,
    isBusy: (documentUri) => runner.isRunning(documentUri),
    rowLimit: (summary) => summary.page?.pageSize ?? readRowLimit(),
    logger,
  });

  const showResults = (documentUri: string): void => {
    ResultsPanel.show(
      {
        extensionUri: context.extensionUri,
        results,
        runner,
        editor,
        saver,
        reloadTable: (resultId, change) => tables.reload(resultId, change),
        exportResult,
        logger,
      },
      documentUri,
    );
  };

  const openTable = async (node: TableNode): Promise<void> => {
    const target: SessionTarget = {
      connectionId: node.connectionId,
      ...(node.scope.database === undefined ? {} : { database: node.scope.database }),
    };
    const table: TableRef = { ...node.scope, name: node.name };
    const documentUri = tableDocumentUri(target, table);
    // The panel opens first, so a slow table shows "Running…" instead of nothing.
    showResults(documentUri);
    await tables.open({ target, table });
  };

  const lenses = new RunCodeLensProvider({ runner, editors, store, logger, showResults });
  context.subscriptions.push(
    lenses,
    // Results belong to a document; closing it throws them away.
    vscode.workspace.onDidCloseTextDocument((document) => {
      results.clearDocument(document.uri.toString());
    }),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, lenses),
    editors.bindings.onDidChange(() => {
      // The dialect may have changed with the connection, so the split may differ.
      lenses.refresh();
    }),
  );

  const settings = createSettings();
  const tree = new ConnectionsTreeProvider({ store, manager, cache, settings, logger });
  context.subscriptions.push(
    tree,
    vscode.window.createTreeView(CONNECTIONS_VIEW_ID, {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
  );

  context.subscriptions.push(
    ...registerCommands({
      logger,
      channel,
      extensionUri: context.extensionUri,
      store,
      manager,
      tree,
      cache,
      editors,
      runner,
      showResults,
      openTable,
      exportResult,
    }),
  );

  const isDevelopment = context.extensionMode !== vscode.ExtensionMode.Production;
  await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.isDevelopment, isDevelopment);

  const version = (context.extension.packageJSON as { version?: string }).version ?? 'unknown';
  const mode = vscode.ExtensionMode[context.extensionMode].toLowerCase();
  logger.info(`DataNest ${version} activated (${mode})`);
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

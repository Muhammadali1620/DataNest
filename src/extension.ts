import * as vscode from 'vscode';
import { createBundleDriverLoader, DriverRegistry } from './drivers/registry';
import { ConnectionManager, type SessionTarget } from './services/connection-manager';
import { ConnectionStore } from './services/connection-store';
import { KnownHosts } from './services/known-hosts';
import { createBundleSshLoader, TunnelPool } from './services/tunnels';
import { createHostKeyCheck } from './vscode/ssh-host-keys';
import { MetadataCache } from './services/metadata-cache';
import type { TableRef } from './core/model/objects';
import { CONFIG_KEYS, CONFIG_SECTION, CONTEXT_KEYS } from './vscode/command-ids';
import { registerCommands } from './vscode/commands';
import { createOutputLogger } from './vscode/logging';
import { QueryRunner } from './services/query-runner';
import {
  type ExportError,
  type ExportFormat,
  exportBytes,
  extensionOf,
  suggestedFileName,
} from './services/result-export';
import { ResultLinks } from './services/result-links';
import type { TableFilter } from './shared/table-filter';
import { ResultCopier } from './services/result-copier';
import { ResultEditor } from './services/result-editor';
import { ResultSaver } from './services/result-saver';
import { QueryHistory } from './services/history';
import { ResultStore } from './services/result-store';
import { TableViewer, tableDocumentUri } from './services/table-view';
import { QueryEditors } from './vscode/editor/query-editor';
import { ObjectEditRegistry } from './vscode/editor/object-edit';
import { ObjectEditors } from './vscode/editor/object-editors';
import { SqlCompletionProvider, TRIGGER_CHARACTERS } from './vscode/editor/completion';
import { RunCodeLensProvider } from './vscode/editor/run-query';
import { SqlFormattingProvider } from './vscode/editor/formatting';
import { DDL_SCHEME, SqlNavigation } from './vscode/editor/navigation';
import { ErrorDiagnostics } from './vscode/editor/error-diagnostics';
import { createBundleFormatterLoader } from './services/sql-format';
import { ResultsPanel } from './vscode/panels/results-panel';
import { RunStatus } from './vscode/editor/run-status';
import {
  createSettings,
  readHistoryLimit,
  readPageSize,
  readQueryTimeoutMs,
  readRowLimit,
} from './vscode/settings';
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
  // ssh2 is a bundle of its own, loaded with the first SSH connection (§7).
  const tunnels = new TunnelPool({ load: createBundleSshLoader(__filename), logger });
  context.subscriptions.push(tunnels);
  const manager = new ConnectionManager({
    store,
    drivers,
    logger,
    tunnels,
    checkHostKey: createHostKeyCheck(new KnownHosts(context.globalState, logger)),
  });
  context.subscriptions.push(manager);
  const cache = new MetadataCache({ logger });

  const editors = new QueryEditors({ store, manager, logger });
  context.subscriptions.push(editors);

  const history = new QueryHistory({
    state: context.globalState,
    logger,
    limit: () => readHistoryLimit(),
    nameOf: (connectionId) => store.get(connectionId)?.name,
  });
  const results = new ResultStore();
  const runner = new QueryRunner({
    history,
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
  const navigation = new SqlNavigation({
    bindings: editors.bindings,
    store,
    manager,
    cache,
    logger,
  });
  context.subscriptions.push(
    navigation,
    vscode.languages.registerHoverProvider({ language: 'sql' }, navigation),
    vscode.languages.registerDefinitionProvider({ language: 'sql' }, navigation),
    vscode.workspace.registerTextDocumentContentProvider(DDL_SCHEME, navigation),
  );
  const formatting = new SqlFormattingProvider({
    bindings: editors.bindings,
    store,
    // sql-formatter is a bundle of its own, loaded on the first format (§7).
    loadFormatter: createBundleFormatterLoader(__filename),
    logger,
  });
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql' }, formatting),
    vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql' }, formatting),
  );
  const tables = new TableViewer({
    manager,
    results,
    cache,
    limits: { pageSize: () => readPageSize() },
    logger,
  });

  /** Writes a result to a file the user picks; the whole result, not just a page. */
  const exportErrorMessage = (error: ExportError): string =>
    error === 'too-large'
      ? vscode.l10n.t('The result does not fit this format (Excel holds about a million rows)')
      : error === 'no-rows'
        ? vscode.l10n.t('There is nothing to export')
        : vscode.l10n.t(
            'This format needs rows and writable columns; computed columns are skipped',
          );

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
    const dialect =
      summary.origin === undefined
        ? undefined
        : (await manager.driverOf(summary.origin.target.connectionId)).dialect;
    const outcome = exportBytes(
      { columns: summary.columns, rows, dialect, edit: summary.edit },
      format,
    );
    if (!outcome.ok) {
      void vscode.window.showWarningMessage(exportErrorMessage(outcome.error));
      return;
    }
    await vscode.workspace.fs.writeFile(target, outcome.data);
    logger.info(`Exported ${rows.length} rows to ${target.fsPath}`);
    void vscode.window.showInformationMessage(vscode.l10n.t('Exported {0} rows', rows.length));
  };

  const editor = new ResultEditor(results);
  const copier = new ResultCopier({ results, manager });
  const links = new ResultLinks(results);
  /** Opens the table a foreign key points at, filtered to the related row. */
  const openRelated = async (
    target: SessionTarget,
    table: TableRef,
    filter: TableFilter,
  ): Promise<void> => {
    showResults(tableDocumentUri(target, table));
    await tables.open({ target, table, filter });
  };
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
        copier,
        links,
        openRelated,
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

  const diagnostics = new ErrorDiagnostics();
  context.subscriptions.push(diagnostics);
  const lenses = new RunCodeLensProvider({
    runner,
    editors,
    store,
    logger,
    showResults,
    diagnostics,
  });
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

  const objectEdits = new ObjectEditRegistry();
  context.subscriptions.push(new ObjectEditors(objectEdits));

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
      history,
      showResults,
      openTable,
      exportResult,
      objectEdits,
      diagnostics,
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // A smaller limit takes effect now, not at the next statement.
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.historyLimit}`)) {
        history.enforceLimit();
      }
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

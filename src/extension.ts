import * as vscode from 'vscode';
import { createBundleDriverLoader, DriverRegistry } from './drivers/registry';
import { ConnectionManager, type SessionTarget } from './services/connection-manager';
import { ConnectionStore } from './services/connection-store';
import { ProjectConnections } from './services/project-connections';
import { ProjectFileWatcher, workspaceProjectFiles } from './vscode/project-files';
import { KnownHosts } from './services/known-hosts';
import { createBundleSshLoader, TunnelPool } from './services/tunnels';
import { createHostKeyCheck } from './vscode/ssh-host-keys';
import { MetadataCache } from './services/metadata-cache';
import type { TableRef } from './core/model/objects';
import { setTranslator } from './core/user-message';
import { CONFIG_KEYS, CONFIG_SECTION, CONTEXT_KEYS } from './vscode/command-ids';
import { registerCommands } from './vscode/commands';
import { createOutputLogger } from './vscode/logging';
import { QueryRunner } from './services/query-runner';
import { policyOf } from './services/write-policy';
import { StreamExporter } from './services/stream-export';
import { exportCommandHandlers } from './vscode/export-commands';
import { chartCommandHandlers } from './vscode/chart-commands';
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
import { TransactionModes } from './vscode/editor/transaction-modes';
import { TransactionStatus } from './vscode/editor/transaction-status';
import {
  createRedisKeySettings,
  createSettings,
  readHistoryLimit,
  readPageSize,
  readQueryTimeoutMs,
  readRowLimit,
  readTransactionMode,
} from './vscode/settings';
import { CONNECTIONS_VIEW_ID, ConnectionsTreeProvider } from './vscode/tree/connections-tree';
import { RedisKeyBrowser } from './services/redis/key-browser';
import type { TableNode } from './vscode/tree/nodes';
import { ConnectionDecorations } from './vscode/tree/connection-decorations';
import { ConnectionsDragAndDrop } from './vscode/tree/connection-dnd';

// The composition root: services are created and wired here, nowhere else (ARCHITECTURE.md §10).
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Reported in the log, so a slow start can be told from a slow editor (V9.1).
  const started = performance.now();
  // Messages of the layers below this one are translated with the editor's l10n bundle,
  // in every bundle (drivers too) and before any service exists (V9.2, D100).
  setTranslator((template, args) => vscode.l10n.t(template, ...args));
  const { logger, channel, disposables } = createOutputLogger();
  context.subscriptions.push(...disposables);

  // Connections the open project shares through .vscode/datanest.json (V4.7).
  const projects = new ProjectConnections({ files: workspaceProjectFiles(), logger });
  const projectFiles = new ProjectFileWatcher(projects, logger);
  context.subscriptions.push(projectFiles);
  const store = new ConnectionStore({
    state: context.globalState,
    secrets: context.secrets,
    logger,
    projects,
  });
  // Read before the tree is drawn, so its first picture already has the project.
  await projectFiles.start();
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
    limits: {
      rowLimit: () => readRowLimit(),
      // A connection's own timeout (V4.9) wins over the setting; 0 there means none.
      timeoutMs: (connectionId) => {
        const own = store.get(connectionId)?.options?.queryTimeout;
        return own === undefined ? readQueryTimeoutMs() : own * 1000;
      },
    },
    logger,
  });
  const transactionModes = new TransactionModes(() => readTransactionMode());
  const transactions = new TransactionStatus({
    editors,
    manager,
    runner,
    modes: transactionModes,
    logger,
  });
  context.subscriptions.push(
    transactions,
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

  const exports = exportCommandHandlers({
    results,
    manager,
    tables,
    exporter: new StreamExporter({ manager, logger }),
    logger,
  });
  const exportResult = exports.exportResult;
  const { chartResult } = chartCommandHandlers({
    extensionUri: context.extensionUri,
    results,
    logger,
  });

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
        chartResult,
        policy: (connectionId) => policyOf(store.get(connectionId)),
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
  const decorations = new ConnectionDecorations(store);
  context.subscriptions.push(decorations);
  const redisKeySettings = createRedisKeySettings();
  const redisKeys = new RedisKeyBrowser({ manager, settings: redisKeySettings, logger });
  const tree = new ConnectionsTreeProvider({
    store,
    projects,
    manager,
    cache,
    settings,
    logger,
    redisKeys,
    redisKeySeparator: () => redisKeySettings.separator(),
  });
  const treeView = vscode.window.createTreeView(CONNECTIONS_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new ConnectionsDragAndDrop(store, logger),
  });
  context.subscriptions.push(
    tree,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
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
      chartResult,
      exportTable: exports.exportTable,
      objectEdits,
      diagnostics,
      reloadProjects: () => projects.reloadAll(),
      transactions,
      transactionModes,
      redisKeys,
      treeView,
      redisKeySeparator: () => redisKeySettings.separator(),
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
  const took = Math.round(performance.now() - started);
  logger.info(`DataNest ${version} activated (${mode}) in ${took} ms`);
}

export function deactivate(): void {
  // Everything else is disposed through context.subscriptions.
  setTranslator(undefined);
}

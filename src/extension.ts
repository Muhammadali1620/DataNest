import * as vscode from 'vscode';
import { join } from 'node:path';
import { SavedQueryStore } from './services/saved-queries';
import { VersionMemory } from './services/version-memory';
import { listAccounts } from './services/users/account-list';
import type { DataNestApi } from './api/types';
import { PluginDrivers } from './drivers/plugin/plugin-drivers';
import { RemoteSnapshots } from './services/remote-snapshots';
import { createBundleDriverLoader, DriverRegistry } from './drivers/registry';
import { createDataNestApi } from './vscode/plugin-api';
import { ConnectionManager, type SessionTarget } from './services/connection-manager';
import { CONNECTIONS_STATE_KEY, ConnectionStore } from './services/connection-store';
import { ProjectConnections } from './services/project-connections';
import { ProjectFileWatcher, workspaceProjectFiles } from './vscode/project-files';
import { KnownHosts } from './services/known-hosts';
import { createBundleSshLoader, TunnelPool } from './services/tunnels';
import { createHostKeyCheck } from './vscode/ssh-host-keys';
import { MetadataCache } from './services/metadata-cache';
import type { TableRef } from './core/model/objects';
import { setTranslator } from './core/user-message';
import { CONFIG_KEYS, CONFIG_SECTION, CONTEXT_KEYS } from './vscode/command-ids';
import { type PageActions, registerCommands } from './vscode/commands';
import { createOutputLogger } from './vscode/logging';
import { QueryRunner } from './services/query-runner';
import { policyOf } from './services/write-policy';
import { StreamExporter } from './services/stream-export';
import { exportCommandHandlers } from './vscode/export-commands';
import { projectQueryHandlers, workspaceProjectQueryFiles } from './vscode/project-query-commands';
import { ProjectQueries } from './services/project-queries';
import { chartCommandHandlers } from './vscode/chart-commands';
import {
  COMPARE_SCHEME,
  CompareListings,
  compareResultsHandler,
} from './vscode/compare-results-commands';
import { pluginConnectionHandlers } from './vscode/plugin-connection-commands';
import { resultHistoryHandlers } from './vscode/result-history-commands';
import { ResultLinks } from './services/result-links';
import type { TableFilter } from './shared/table-filter';
import { ResultCopier } from './services/result-copier';
import { ResultEditor } from './services/result-editor';
import { ResultSaver } from './services/result-saver';
import { QueryHistory } from './services/history';
import { QueryVariableMemory } from './services/query-variables';
import { BindingMemory } from './services/binding-memory';
import { StatementView } from './vscode/editor/statement-view';
import { ResultStore } from './services/result-store';
import { ResultMemory, ResultRestorer } from './services/result-memory';
import { isReadOnlyStatement } from './core/sql/read-only';
import { syntaxOf } from './core/sql/tokenizer';
import { registerResultRestore } from './vscode/result-restore';
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
  createEtcdKeySettings,
  createZookeeperSettings,
  createRedisKeySettings,
  createSettings,
  readHistoryLimit,
  readPageSize,
  readQueryTimeoutMs,
  readEditorSwitch,
  readSyncConnections,
  readQueryVariablesMode,
  readRemoteMaxBytes,
  readServersMaxOpenBytes,
  readServersShowHidden,
  readAiEnabled,
  readResultsRestore,
  readResultsRestoreRun,
  readRowLimit,
  readTransactionMode,
} from './vscode/settings';
import { CONNECTIONS_VIEW_ID, ConnectionsTreeProvider } from './vscode/tree/connections-tree';
import { RedisKeyBrowser } from './services/redis/key-browser';
import { EtcdKeyBrowser } from './services/etcd/key-browser';
import { ZookeeperNodeBrowser } from './services/zookeeper/node-browser';
import type { TableNode } from './vscode/tree/nodes';
import { ConnectionDecorations } from './vscode/tree/connection-decorations';
import { AiTools } from './services/ai-tools';
import { browseSession } from './services/browse-session';
import { registerAiTools } from './vscode/ai-tools';
import { registerChatParticipant } from './vscode/ai-chat';
import { FavoritesStore } from './vscode/tree/favorites';
import { ConnectionsDragAndDrop } from './vscode/tree/connection-dnd';
import { ServerStore } from './services/server-store';
import { SftpHub } from './services/sftp-hub';
import { SFTP_SCHEME } from './vscode/servers/server-model';
import { SftpFileSystem } from './vscode/servers/sftp-file-system';
import { type ServerCommands, serverCommandHandlers } from './vscode/servers/server-commands';
import { terminalCommandHandlers } from './vscode/servers/terminal-commands';
import { SERVERS_VIEW_ID, ServersTree } from './vscode/servers/servers-tree';

// The composition root: services are created and wired here, nowhere else (ARCHITECTURE.md §10).
export async function activate(context: vscode.ExtensionContext): Promise<DataNestApi> {
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
  // Settings Sync carries the list — never the passwords, which stay in SecretStorage —
  // only when the user asks for it (V10.2.5).
  const applySync = (): void => {
    context.globalState.setKeysForSync(readSyncConnections() ? [CONNECTIONS_STATE_KEY] : []);
  };
  applySync();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.syncConnections}`)) {
        applySync();
      }
    }),
    // A synced list arrives without an event: look again when the window comes back.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && readSyncConnections()) {
        store.reload();
      }
    }),
  );
  // Read before the tree is drawn, so its first picture already has the project.
  await projectFiles.start();
  // Drivers other extensions register through the public API (V12.7).
  const plugins = new PluginDrivers();
  const drivers = new DriverRegistry({
    // Driver bundles sit next to the extension bundle and load on first use (§7).
    loader: createBundleDriverLoader(__filename),
    logger,
    plugins,
  });
  // ssh2 is a bundle of its own, loaded with the first SSH connection (§7).
  const tunnels = new TunnelPool({ load: createBundleSshLoader(__filename), logger });
  context.subscriptions.push(tunnels);
  // SQLite files on a server are copied here over SFTP and opened read-only (V12.8).
  const snapshots = new RemoteSnapshots({
    downloader: tunnels,
    folder: join(context.globalStorageUri.fsPath, 'remote-sqlite'),
    logger,
  });
  void snapshots.sweep();
  context.subscriptions.push({
    dispose: () => {
      void snapshots.dispose();
    },
  });
  const hostKeyCheck = createHostKeyCheck(new KnownHosts(context.globalState, logger));
  const manager = new ConnectionManager({
    store,
    drivers,
    logger,
    tunnels,
    checkHostKey: hostKeyCheck,
    snapshots,
    remoteMaxBytes: readRemoteMaxBytes,
    execs: tunnels,
  });
  context.subscriptions.push(manager);
  const cache = new MetadataCache({ logger });

  const editors = new QueryEditors({
    store,
    manager,
    logger,
    memory: new BindingMemory(context.workspaceState),
  });
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
      new SqlCompletionProvider({
        editors,
        store,
        manager,
        cache,
        logger,
        enabled: () =>
          vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<boolean>(CONFIG_KEYS.completionEnabled, true),
      }),
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
  const compareListings = new CompareListings();
  context.subscriptions.push(
    compareListings,
    vscode.workspace.registerTextDocumentContentProvider(COMPARE_SCHEME, compareListings),
  );
  const compareResults = compareResultsHandler({ results, listings: compareListings });
  const pluginConnections = pluginConnectionHandlers({ store, plugins });
  const resultHistory = resultHistoryHandlers({
    results,
    show: (documentUri, resultId) => {
      showResults(documentUri);
      ResultsPanel.find(documentUri)?.select(resultId);
    },
  });
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

  const pageActions: PageActions = {};
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
        importInto: (connectionId, table) =>
          pageActions.importInto?.(connectionId, table) ?? Promise.resolve(),
        runSql: (request) =>
          pageActions.runSql?.(request) ??
          Promise.resolve({ ok: false, error: vscode.l10n.t('Try again in a moment') }),
        targetOf: (uri) => tables.viewOf(uri)?.target ?? editors.bindings.get(uri),
        tableOf: (uri) => tables.viewOf(uri),
        chartResult,
        showHistory: (uri) => resultHistory.showHistory(uri),
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
    await tables.open({ target, table, kind: node.tableKind });
  };

  // The result tabs of saved SQL files come back after a restart, empty (V13.12).
  const resultMemory = new ResultMemory(context.workspaceState);
  const rememberRules = {
    isReadOnly: (statement: string, connectionId: string): boolean =>
      isReadOnlyStatement(statement, syntaxOf(store.get(connectionId)?.driver)),
  };
  context.subscriptions.push(
    registerResultRestore({
      results,
      memory: resultMemory,
      restorer: new ResultRestorer({
        memory: resultMemory,
        results,
        connectionOf: (connectionId) => {
          const config = store.get(connectionId);
          return config === undefined
            ? undefined
            : { disabled: config.disabled === true, production: config.production === true };
        },
        rules: rememberRules,
        run: async (request) =>
          (await pageActions.runSql?.(request)) ?? { ok: false, error: 'not ready' },
        autoRun: () => readResultsRestoreRun(),
        onError: (error) => {
          logger.warn('Could not run a restored result tab', error);
        },
      }),
      rules: rememberRules,
      enabled: () => readResultsRestore(),
      showResults,
      onConnectionsChanged: (listener) => store.onDidChange(listener),
      logger,
    }),
  );

  const diagnostics = new ErrorDiagnostics();
  context.subscriptions.push(diagnostics);
  const lenses = new RunCodeLensProvider({
    runner,
    editors,
    store,
    logger,
    showResults,
    diagnostics,
    codeLens: () => readEditorSwitch(CONFIG_KEYS.editorCodeLens),
  });
  const statementView = new StatementView({
    driverOf: (documentUri) => {
      const binding = editors.bindings.get(documentUri);
      return binding === undefined ? undefined : store.get(binding.connectionId)?.driver;
    },
    highlight: () => readEditorSwitch(CONFIG_KEYS.editorHighlightStatement),
    fold: () => readEditorSwitch(CONFIG_KEYS.editorFoldStatements),
  });
  context.subscriptions.push(
    lenses,
    statementView,
    // Results belong to a document; closing it throws them away.
    vscode.workspace.onDidCloseTextDocument((document) => {
      results.clearDocument(document.uri.toString());
    }),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, lenses),
    editors.bindings.onDidChange(() => {
      // The dialect may have changed with the connection, so the split may differ.
      lenses.refresh();
      statementView.applySettings();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.editor`)) {
        lenses.refresh();
        statementView.applySettings();
      }
    }),
  );

  const settings = createSettings();
  const favorites = new FavoritesStore(context.globalState);
  const decorations = new ConnectionDecorations(store, favorites);
  context.subscriptions.push(decorations);
  const redisKeySettings = createRedisKeySettings();
  const redisKeys = new RedisKeyBrowser({ manager, settings: redisKeySettings, logger });
  const etcdKeys = new EtcdKeyBrowser({ manager, settings: createEtcdKeySettings(), logger });
  const zookeeperNodes = new ZookeeperNodeBrowser({
    manager,
    settings: createZookeeperSettings(),
    logger,
  });
  // Saved queries are plain files, kept in the extension's global storage (V11.12).
  const savedQueries = new SavedQueryStore(join(context.globalStorageUri.fsPath, 'queries'));
  const versionMemory = new VersionMemory(context.globalState);
  const tree = new ConnectionsTreeProvider({
    extensionUri: context.extensionUri,
    store,
    favorites,
    versionMemory,
    projects,
    manager,
    cache,
    settings,
    logger,
    redisKeys,
    etcdKeys,
    zookeeperNodes,
    redisKeySeparator: () => redisKeySettings.separator(),
    savedQueries: {
      list: async (connectionId, scope) => await savedQueries.list(connectionId, scope),
    },
    accounts: async (connectionId) => await listAccounts(manager, connectionId),
  });
  const treeView = vscode.window.createTreeView(CONNECTIONS_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new ConnectionsDragAndDrop(
      store,
      logger,
      async (connectionId) => (await manager.driverOf(connectionId)).dialect,
    ),
  });
  // A removed connection, or one that now points elsewhere, loses its remembered version.
  const pruneVersions = (): void => {
    void versionMemory.prune(new Map(store.list().map((config) => [config.id, config])));
  };
  pruneVersions();
  context.subscriptions.push(
    tree,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    store.onDidChange(pruneVersions),
  );

  // The editor's language model may read schemas and run statements that only read (V13.15).
  const aiTools = new AiTools({
    store,
    enabled: () => readAiEnabled(),
    capabilitiesOf: async (connectionId) => (await manager.driverOf(connectionId)).capabilities,
    browse: async (connectionId, database) => await browseSession(manager, connectionId, database),
    query: async (connectionId, database) =>
      await manager.acquire(
        `ai-tools:${connectionId}`,
        database === undefined ? { connectionId } : { connectionId, database },
      ),
  });
  context.subscriptions.push(
    ...registerAiTools(aiTools, logger),
    ...registerChatParticipant({
      tools: aiTools,
      connections: () => store.list(),
      enabled: () => readAiEnabled(),
      logger,
    }),
  );

  const objectEdits = new ObjectEditRegistry();
  context.subscriptions.push(new ObjectEditors(objectEdits));

  // Saved SSH servers and their files over SFTP, a view of their own (V13.16).
  const serverStore = new ServerStore({
    state: context.globalState,
    secrets: context.secrets,
    logger,
  });
  const sftpHub = new SftpHub({
    store: serverStore,
    opener: tunnels,
    checkHostKey: hostKeyCheck,
    logger,
  });
  const serverTreeBridge: { drop?: ServerCommands['drop']; move?: ServerCommands['moveEntries'] } =
    {};
  const serversTree = new ServersTree({
    store: serverStore,
    hub: sftpHub,
    showHidden: readServersShowHidden,
    onDropFiles: async (target, paths) => {
      await serverTreeBridge.drop?.(target, paths);
    },
    onMoveEntries: async (target, entries) => {
      await serverTreeBridge.move?.(target, entries);
    },
  });
  const serverCommands = serverCommandHandlers({
    store: serverStore,
    hub: sftpHub,
    tree: serversTree,
    logger,
    extensionUri: context.extensionUri,
    maxOpenBytes: readServersMaxOpenBytes,
  });
  serverTreeBridge.drop = serverCommands.drop;
  serverTreeBridge.move = serverCommands.moveEntries;
  const terminalCommands = terminalCommandHandlers({
    store: serverStore,
    opener: tunnels,
    checkHostKey: hostKeyCheck,
    logger,
  });
  const sftpFiles = new SftpFileSystem({
    hub: sftpHub,
    store: serverStore,
    maxOpenBytes: readServersMaxOpenBytes,
  });
  context.subscriptions.push(
    sftpHub,
    serversTree,
    sftpFiles,
    vscode.window.createTreeView(SERVERS_VIEW_ID, {
      treeDataProvider: serversTree,
      showCollapseAll: true,
      canSelectMany: true,
      dragAndDropController: serversTree,
    }),
    vscode.workspace.registerFileSystemProvider(SFTP_SCHEME, sftpFiles, { isCaseSensitive: true }),
  );

  const variableMemory = new QueryVariableMemory(context.workspaceState);
  context.subscriptions.push(
    ...registerCommands({
      servers: serverCommands.handlers,
      terminals: terminalCommands,
      extensionVersion:
        (context.extension.packageJSON as { version?: string }).version ?? 'unknown',
      logger,
      channel,
      extensionUri: context.extensionUri,
      secrets: context.secrets,
      store,
      serverStore,
      manager,
      tree,
      cache,
      editors,
      runner,
      history,
      showResults,
      pageActions,
      openTable,
      exportResult,
      chartResult,
      compareResults,
      resultHistory,
      pluginConnections,
      projectConnections: projects,
      results,
      projectQueries: projectQueryHandlers({
        queries: new ProjectQueries(workspaceProjectQueryFiles()),
        projects,
        store,
        editors,
      }),
      exportTable: exports.exportTable,
      objectEdits,
      diagnostics,
      reloadProjects: () => projects.reloadAll(),
      transactions,
      transactionModes,
      variableMemory,
      openFiltered: openRelated,
      redisKeys,
      etcdKeys,
      zookeeperNodes,
      treeView,
      favorites,
      redisKeySeparator: () => redisKeySettings.separator(),
      savedQueries,
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // A smaller limit takes effect now, not at the next statement.
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.historyLimit}`)) {
        history.enforceLimit();
      }
      // Values that are no longer to be remembered are not kept either.
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.queryVariables}`) &&
        readQueryVariablesMode() !== 'remember'
      ) {
        void variableMemory.clear();
      }
    }),
  );

  const isDevelopment = context.extensionMode !== vscode.ExtensionMode.Production;
  await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.isDevelopment, isDevelopment);

  const version = (context.extension.packageJSON as { version?: string }).version ?? 'unknown';
  const mode = vscode.ExtensionMode[context.extensionMode].toLowerCase();
  const took = Math.round(performance.now() - started);
  logger.info(`DataNest ${version} activated (${mode}) in ${took} ms`);
  return createDataNestApi(plugins, logger);
}

export function deactivate(): void {
  // Everything else is disposed through context.subscriptions.
  setTranslator(undefined);
}

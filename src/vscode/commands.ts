import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import type { MetadataCache } from '../services/metadata-cache';
import type { QueryEditors } from './editor/query-editor';
import { runCommandHandlers } from './editor/run-query';
import type { QueryRunner } from '../services/query-runner';
import { EXPORT_FORMATS, type ExportFormat, isExportFormat } from '../services/result-export';
import { connectionIdOf, isTreeNode, scopeOf, type TableNode, type TreeNode } from './tree/nodes';
import { definitionDocument, readDefinitionDocument } from '../services/object-definitions';
import type { ObjectRef } from '../core/model/objects';
import { objectEditHandlers, type ObjectEditRegistry } from './editor/object-edit';
import type { ErrorDiagnostics } from './editor/error-diagnostics';
import { SchemaActions } from '../services/schema-actions';
import { browseSession } from '../services/browse-session';
import { schemaCommandHandlers, schemaPerformer } from './tree/schema-commands';
import { TableDesignerPanel } from './panels/table-designer-panel';
import type { DocumentBinding } from './editor/document-bindings';
import { schemaTexts, schemaUi } from './tree/schema-ui';
import type { ConnectionsTreeProvider } from './tree/connections-tree';
import { type CommandTarget, treeCommandHandlers } from './tree/tree-commands';
import { COMMAND_IDS, type CommandId } from './command-ids';
import { guardCommand } from './command-runner';
import { connectionCommandHandlers } from './connection-commands';
import { addConnectionFromUrl, importConnectionsFromEnv } from './connection-import';
import { folderCommandHandlers } from './tree/folder-commands';
import { projectCommandHandlers } from './project-commands';
import { filterCommandHandlers } from './tree/filter-commands';
import { transferCommandHandlers } from './connection-transfer-commands';
import { scriptCommandHandlers } from './script-commands';
import { dumpCommandHandlers } from './dump-commands';
import { tableTransferCommandHandlers } from './transfer-commands';
import { TableTransferService } from '../services/transfer/table-transfer';
import { importCommandHandlers } from './import-commands';
import { DataImportPanel } from './panels/data-import-panel';
import { TestDataPanel } from './panels/test-data-panel';
import { SqlDumper } from '../services/sql-dump';
import { ScriptRunner } from '../services/script-runner';
import { policyOf } from '../services/write-policy';
import { ConnectionFormPanel } from './panels/connection-form-panel';
import type { QueryHistory } from '../services/history';
import { showHistory } from './history/history-picker';
import { showObjectSearch } from './search/object-search';
import { templateCommandHandlers } from './tree/template-commands';
import { createSettings } from './settings';
import { ResultsPanel } from './panels/results-panel';
import { PingPanel } from './panels/ping-panel';
import type { TransactionStatus } from './editor/transaction-status';
import type { TransactionModes } from './editor/transaction-modes';

export interface CommandDeps {
  readonly logger: Logger;
  readonly channel: vscode.OutputChannel;
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly tree: ConnectionsTreeProvider;
  readonly cache: MetadataCache;
  readonly editors: QueryEditors;
  readonly runner: QueryRunner;
  readonly history: QueryHistory;
  readonly showResults: (documentUri: string) => void;
  /** Opens a table from the tree as a paged result. */
  readonly openTable: (node: TableNode) => Promise<void>;
  /** Marks the errors of a run in its editor (V3.11). */
  readonly diagnostics: ErrorDiagnostics;
  /** Which open editors edit the definition of an object. */
  readonly objectEdits: ObjectEditRegistry;
  /** Writes a result to a file the user picks. */
  readonly exportResult: (resultId: string, format: ExportFormat) => Promise<void>;
  /** Writes every row of a tree table to a file (V5.4). */
  readonly exportTable: (target?: unknown) => Promise<void>;
  /** Reads the project connection files again. */
  readonly reloadProjects?: () => Promise<void>;
  /** The transaction of the active editor: its status and Commit/Rollback (V4.8). */
  readonly transactions: TransactionStatus;
  readonly transactionModes: TransactionModes;
}

/** The items selected in the tree, which VS Code passes after the clicked one. */
function selectionOf(value: unknown): TreeNode[] | undefined {
  return Array.isArray(value) ? value.filter(isTreeNode) : undefined;
}

/** Registers every command in one place; handlers are guarded against unhandled errors. */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const runner = {
    logger: deps.logger,
    showError: (message: string) =>
      vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', message)),
  };
  const importDeps = {
    extensionUri: deps.extensionUri,
    store: deps.store,
    manager: deps.manager,
    logger: deps.logger,
  };
  const connections = connectionCommandHandlers(importDeps);
  const folders = folderCommandHandlers({ store: deps.store });
  const projects = projectCommandHandlers(importDeps);
  const transfer = transferCommandHandlers({ store: deps.store, logger: deps.logger });
  const scripts = scriptCommandHandlers({
    store: deps.store,
    manager: deps.manager,
    runner: new ScriptRunner({ manager: deps.manager, logger: deps.logger }),
    bindings: deps.editors.bindings,
    refresh: (connectionId) => {
      deps.cache.invalidate(connectionId);
      deps.tree.refresh();
    },
    logger: deps.logger,
  });
  const dumps = dumpCommandHandlers({
    store: deps.store,
    manager: deps.manager,
    cache: deps.cache,
    dumper: new SqlDumper({ manager: deps.manager, logger: deps.logger }),
    logger: deps.logger,
  });
  const transfers = tableTransferCommandHandlers({
    store: deps.store,
    manager: deps.manager,
    cache: deps.cache,
    service: new TableTransferService({ manager: deps.manager, logger: deps.logger }),
    refresh: (connectionId) => {
      deps.cache.invalidate(connectionId);
      deps.tree.refresh();
    },
    logger: deps.logger,
  });
  const imports = importCommandHandlers({
    extensionUri: deps.extensionUri,
    openEditor: async (binding, sql) => await deps.editors.newQuery(binding, sql),
    store: deps.store,
    manager: deps.manager,
    cache: deps.cache,
    logger: deps.logger,
  });
  const filters = filterCommandHandlers({
    store: deps.store,
    manager: deps.manager,
    cache: deps.cache,
    settings: createSettings(),
  });
  const runCommands = runCommandHandlers({
    runner: deps.runner,
    editors: deps.editors,
    store: deps.store,
    logger: deps.logger,
    showResults: deps.showResults,
    diagnostics: deps.diagnostics,
    isManual: (documentUri) => deps.transactionModes.modeOf(documentUri) === 'manual',
    transactionState: (documentUri) =>
      deps.manager.transactionState(ConnectionManager.editorOwner(documentUri)),
  });
  /** Opens the DDL of an object in a new SQL editor on its connection and database. */
  const showDefinition = async (connectionId: string, object: ObjectRef): Promise<void> => {
    const text = await readDefinitionDocument(deps.manager, connectionId, object);
    await deps.editors.newQuery(
      object.database === undefined
        ? { connectionId }
        : { connectionId, database: object.database },
      text,
    );
  };
  const treeCommands = treeCommandHandlers({
    manager: deps.manager,
    tree: deps.tree,
    cache: deps.cache,
    openTable: deps.openTable,
    showDefinition,
    clipboard: vscode.env.clipboard,
    noTargetMessage: vscode.l10n.t('Pick a connection in the DataNest view first'),
    reloadProjects: deps.reloadProjects,
    confirmDisconnect: async (connectionId) => {
      const open = deps.manager.ownersInTransaction(connectionId).length;
      if (open === 0) {
        return true;
      }
      const disconnect = vscode.l10n.t('Disconnect');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('{0} editor(s) have an open transaction. Disconnect anyway?', open),
        {
          modal: true,
          detail: vscode.l10n.t('The server rolls back every change that was not committed.'),
        },
        disconnect,
      );
      return choice === disconnect;
    },
  });
  const schemaDeps = {
    actions: new SchemaActions({ manager: deps.manager, cache: deps.cache, logger: deps.logger }),
    ui: schemaUi(),
    texts: schemaTexts(),
    tree: deps.tree,
    openEditor: async (binding: DocumentBinding, sql: string) =>
      await deps.editors.newQuery(binding, sql),
    policy: (connectionId: string) => policyOf(deps.store.get(connectionId)),
  };
  const perform = schemaPerformer(schemaDeps);
  const schemaCommands = schemaCommandHandlers({
    ...schemaDeps,
    manager: deps.manager,
    openDesigner: async (connectionId, scope, table) =>
      TableDesignerPanel.show({
        extensionUri: deps.extensionUri,
        logger: deps.logger,
        connectionId,
        scope,
        ...(table === undefined ? {} : { table }),
        driver: await deps.manager.driverOf(connectionId),
        metadata: async () =>
          deps.cache.wrap(
            connectionId,
            (await browseSession(deps.manager, connectionId, scope.database)).metadata,
          ),
        texts: {
          createTable: (name) => schemaDeps.texts.createTable(name),
          create: schemaDeps.texts.create,
          alterTable: (name) => schemaDeps.texts.alterTable(name),
          apply: schemaDeps.texts.apply,
        },
        perform,
      }),
  });
  const objectEdits = objectEditHandlers({
    manager: deps.manager,
    registry: deps.objectEdits,
    readDefinition: async (connectionId, object) =>
      await (
        await browseSession(deps.manager, connectionId, object.database)
      ).metadata.getDefinition(object),
    renderDefinition: async (connectionId, statements) =>
      definitionDocument(statements, (await deps.manager.driverOf(connectionId)).id),
    openDocument: async (binding, text) =>
      (await deps.editors.newQuery(binding, text)).uri.toString(),
    textOf: (documentUri) =>
      vscode.workspace.textDocuments
        .find((document) => document.uri.toString() === documentUri)
        ?.getText(),
    perform,
    info: (message) => {
      void vscode.window.showInformationMessage(message);
    },
    texts: {
      applyTitle: (name) => vscode.l10n.t('Replace "{0}" with the edited definition?', name),
      apply: vscode.l10n.t('Apply'),
      notAnObjectEditor: vscode.l10n.t(
        'This editor does not edit a database object: open one with "Edit Definition…" in the DataNest view',
      ),
      nothingToApply: vscode.l10n.t('Nothing to apply: the editor is empty'),
    },
  });
  const generate = templateCommandHandlers({
    dialectOf: async (connectionId) => (await deps.manager.driverOf(connectionId)).dialect,
    metadataOf: async (connectionId, database) =>
      deps.cache.wrap(
        connectionId,
        (await browseSession(deps.manager, connectionId, database)).metadata,
      ),
    openSnippet: async (binding, snippet) => {
      await deps.editors.newQuery(binding);
      await vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(snippet));
    },
  });
  let pings: PingPanel[] = [];
  const handlers: Record<CommandId, (target?: CommandTarget, ...rest: unknown[]) => unknown> = {
    [COMMAND_IDS.showLogs]: () => {
      deps.channel.show(true);
    },
    [COMMAND_IDS.addConnection]: connections.add,
    [COMMAND_IDS.createFolder]: folders.createFolder,
    [COMMAND_IDS.renameFolder]: folders.renameFolder,
    [COMMAND_IDS.removeFolder]: folders.removeFolder,
    [COMMAND_IDS.moveToFolder]: (target, ...rest: unknown[]) =>
      folders.moveToFolder(target, selectionOf(rest[0])),
    [COMMAND_IDS.setConnectionColor]: folders.setColor,
    [COMMAND_IDS.moveToProject]: projects.moveToProject,
    [COMMAND_IDS.moveToUser]: projects.moveToUser,
    [COMMAND_IDS.openProjectFile]: projects.openFile,
    [COMMAND_IDS.filterDatabases]: filters.filterDatabases,
    [COMMAND_IDS.filterSchemas]: filters.filterSchemas,
    [COMMAND_IDS.addConnectionFromUrl]: (target) =>
      addConnectionFromUrl(importDeps, typeof target === 'string' ? target : undefined),
    [COMMAND_IDS.importEnvConnections]: () => importConnectionsFromEnv(importDeps),
    [COMMAND_IDS.exportConnections]: () => transfer.exportConnections(),
    [COMMAND_IDS.importConnections]: (target) => transfer.importConnections(target),
    [COMMAND_IDS.editConnection]: connections.edit,
    [COMMAND_IDS.duplicateConnection]: connections.duplicate,
    [COMMAND_IDS.removeConnection]: connections.remove,
    [COMMAND_IDS.connect]: treeCommands.connect,
    [COMMAND_IDS.disconnect]: treeCommands.disconnect,
    [COMMAND_IDS.refreshTree]: treeCommands.refresh,
    [COMMAND_IDS.copyName]: treeCommands.copyName,
    [COMMAND_IDS.openTable]: treeCommands.openTable,
    [COMMAND_IDS.showDefinition]: treeCommands.showDefinition,
    [COMMAND_IDS.createDatabase]: schemaCommands.createDatabase,
    [COMMAND_IDS.dropDatabase]: schemaCommands.dropDatabase,
    [COMMAND_IDS.createSchema]: schemaCommands.createSchema,
    [COMMAND_IDS.dropSchema]: schemaCommands.dropSchema,
    [COMMAND_IDS.createTable]: schemaCommands.createTable,
    [COMMAND_IDS.designTable]: schemaCommands.designTable,
    [COMMAND_IDS.generateSelect]: generate('select'),
    [COMMAND_IDS.generateInsert]: generate('insert'),
    [COMMAND_IDS.generateUpdate]: generate('update'),
    [COMMAND_IDS.generateDelete]: generate('delete'),
    [COMMAND_IDS.dropTable]: schemaCommands.dropTable,
    [COMMAND_IDS.renameTable]: schemaCommands.renameTable,
    [COMMAND_IDS.truncateTable]: schemaCommands.truncateTable,
    [COMMAND_IDS.dropObject]: schemaCommands.dropObject,
    [COMMAND_IDS.editObject]: objectEdits.edit,
    [COMMAND_IDS.applyObject]: async (target?: unknown) =>
      await objectEdits.apply(
        typeof target === 'string'
          ? target
          : vscode.window.activeTextEditor?.document.uri.toString(),
      ),
    [COMMAND_IDS.runSqlFile]: (target) => scripts.runFile(target),
    [COMMAND_IDS.importData]: (target) => imports.importData(target),
    [COMMAND_IDS.generateData]: (target) => imports.generateData(target),
    [COMMAND_IDS.transferTables]: (target, ...rest: unknown[]) =>
      transfers.transfer(target, selectionOf(rest[0])),
    [COMMAND_IDS.exportData]: (target) => deps.exportTable(target),
    [COMMAND_IDS.dumpSql]: (target, ...rest: unknown[]) => dumps.dump(target, selectionOf(rest[0])),
    [COMMAND_IDS.exportResult]: async () => {
      const document = vscode.window.activeTextEditor?.document;
      const panel =
        document?.languageId === 'sql' ? ResultsPanel.find(document.uri.toString()) : undefined;
      const resultId = panel?.activeResultId;
      if (resultId === undefined) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Run a query first: there is no result to export'),
        );
        return undefined;
      }
      const format = await vscode.window.showQuickPick([...EXPORT_FORMATS], {
        placeHolder: vscode.l10n.t('Pick a format'),
      });
      if (format === undefined || !isExportFormat(format)) {
        return undefined;
      }
      await deps.exportResult(resultId, format);
      return undefined;
    },
    [COMMAND_IDS.showHistory]: () => {
      showHistory({ history: deps.history, store: deps.store, editors: deps.editors });
    },
    [COMMAND_IDS.searchObjects]: () => {
      const settings = createSettings();
      showObjectSearch({
        manager: deps.manager,
        store: deps.store,
        cache: deps.cache,
        showSystemObjects: () => settings.showSystemObjects(),
        openTable: deps.openTable,
        showDefinition,
        logger: deps.logger,
      });
    },
    [COMMAND_IDS.newQuery]: async (target?: CommandTarget) => {
      // From the tree the query starts on the clicked connection and database.
      const connectionId = connectionIdOf(target);
      if (connectionId === undefined) {
        return await deps.editors.newQuery();
      }
      const scope = isTreeNode(target) ? scopeOf(target) : {};
      return await deps.editors.newQuery(
        scope.database === undefined
          ? { connectionId }
          : { connectionId, database: scope.database },
      );
    },
    [COMMAND_IDS.selectConnection]: async () => await deps.editors.selectConnection(),
    [COMMAND_IDS.runQuery]: runCommands.run,
    [COMMAND_IDS.runAll]: runCommands.runAll,
    [COMMAND_IDS.runRange]: runCommands.runRange,
    [COMMAND_IDS.cancelQuery]: runCommands.cancel,
    [COMMAND_IDS.commitTransaction]: () => deps.transactions.end('commit'),
    [COMMAND_IDS.rollbackTransaction]: () => deps.transactions.end('rollback'),
    [COMMAND_IDS.toggleTransactionMode]: () => {
      deps.transactions.toggleMode();
    },
    [COMMAND_IDS.showResults]: () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document?.languageId !== 'sql') {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
        );
        return undefined;
      }
      deps.showResults(document.uri.toString());
      return undefined;
    },
    [COMMAND_IDS.openPing]: () => {
      const panel = new PingPanel(deps.extensionUri, deps.logger);
      pings = [...pings.filter((open) => !open.isDisposed), panel];
      return panel;
    },
  };
  const commands = Object.entries(handlers).map(([id, handler]) =>
    vscode.commands.registerCommand(id, guardCommand(id, handler, runner)),
  );
  return [
    ...commands,
    {
      dispose: () => {
        for (const panel of pings) {
          panel.dispose();
        }
        pings = [];
        ConnectionFormPanel.disposeAll();
        TableDesignerPanel.disposeAll();
        DataImportPanel.disposeAll();
        TestDataPanel.disposeAll();
        ResultsPanel.disposeAll();
      },
    },
  ];
}

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import type { MetadataCache } from '../services/metadata-cache';
import type { QueryEditors } from './editor/query-editor';
import { runCommandHandlers } from './editor/run-query';
import type { QueryRunner } from '../services/query-runner';
import { EXPORT_FORMATS, type ExportFormat, isExportFormat } from '../services/result-export';
import { connectionIdOf, isTreeNode, scopeOf, type TableNode } from './tree/nodes';
import { readDefinitionDocument } from '../services/object-definitions';
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
import { ConnectionFormPanel } from './panels/connection-form-panel';
import type { QueryHistory } from '../services/history';
import { showHistory } from './history/history-picker';
import { ResultsPanel } from './panels/results-panel';
import { PingPanel } from './panels/ping-panel';

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
  /** Writes a result to a file the user picks. */
  readonly exportResult: (resultId: string, format: ExportFormat) => Promise<void>;
}

/** Registers every command in one place; handlers are guarded against unhandled errors. */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const runner = {
    logger: deps.logger,
    showError: (message: string) =>
      vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', message)),
  };
  const connections = connectionCommandHandlers({
    extensionUri: deps.extensionUri,
    store: deps.store,
    manager: deps.manager,
    logger: deps.logger,
  });
  const runCommands = runCommandHandlers({
    runner: deps.runner,
    editors: deps.editors,
    store: deps.store,
    logger: deps.logger,
    showResults: deps.showResults,
  });
  const treeCommands = treeCommandHandlers({
    manager: deps.manager,
    tree: deps.tree,
    cache: deps.cache,
    openTable: deps.openTable,
    showDefinition: async (connectionId, object) => {
      const text = await readDefinitionDocument(deps.manager, connectionId, object);
      await deps.editors.newQuery(
        object.database === undefined
          ? { connectionId }
          : { connectionId, database: object.database },
        text,
      );
    },
    clipboard: vscode.env.clipboard,
    noTargetMessage: vscode.l10n.t('Pick a connection in the DataNest view first'),
  });
  const schemaDeps = {
    actions: new SchemaActions({ manager: deps.manager, cache: deps.cache, logger: deps.logger }),
    ui: schemaUi(),
    texts: schemaTexts(),
    tree: deps.tree,
    openEditor: async (binding: DocumentBinding, sql: string) =>
      await deps.editors.newQuery(binding, sql),
  };
  const perform = schemaPerformer(schemaDeps);
  const schemaCommands = schemaCommandHandlers({
    ...schemaDeps,
    manager: deps.manager,
    openDesigner: async (connectionId, scope) =>
      TableDesignerPanel.show({
        extensionUri: deps.extensionUri,
        logger: deps.logger,
        connectionId,
        scope,
        driver: await deps.manager.driverOf(connectionId),
        metadata: async () =>
          deps.cache.wrap(
            connectionId,
            (await browseSession(deps.manager, connectionId, scope.database)).metadata,
          ),
        texts: {
          createTable: (name) => schemaDeps.texts.createTable(name),
          create: schemaDeps.texts.create,
        },
        perform,
      }),
  });
  let pings: PingPanel[] = [];
  const handlers: Record<CommandId, (target?: CommandTarget) => unknown> = {
    [COMMAND_IDS.showLogs]: () => {
      deps.channel.show(true);
    },
    [COMMAND_IDS.addConnection]: connections.add,
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
    [COMMAND_IDS.dropTable]: schemaCommands.dropTable,
    [COMMAND_IDS.renameTable]: schemaCommands.renameTable,
    [COMMAND_IDS.truncateTable]: schemaCommands.truncateTable,
    [COMMAND_IDS.dropObject]: schemaCommands.dropObject,
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
        ResultsPanel.disposeAll();
      },
    },
  ];
}

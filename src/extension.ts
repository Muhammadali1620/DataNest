import * as vscode from 'vscode';
import { createBundleDriverLoader, DriverRegistry } from './drivers/registry';
import { ConnectionManager } from './services/connection-manager';
import { ConnectionStore } from './services/connection-store';
import { MetadataCache } from './services/metadata-cache';
import { CONTEXT_KEYS } from './vscode/command-ids';
import { registerCommands } from './vscode/commands';
import { createOutputLogger } from './vscode/logging';
import { QueryRunner } from './services/query-runner';
import { ResultStore } from './services/result-store';
import { QueryEditors } from './vscode/editor/query-editor';
import { RunCodeLensProvider } from './vscode/editor/run-query';
import { RunStatus } from './vscode/editor/run-status';
import { createSettings, readRowLimit } from './vscode/settings';
import { CONNECTIONS_VIEW_ID, ConnectionsTreeProvider } from './vscode/tree/connections-tree';

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
    limits: { rowLimit: () => readRowLimit() },
    logger,
  });
  context.subscriptions.push(new RunStatus(runner));
  const lenses = new RunCodeLensProvider({ runner, editors, store, logger });
  context.subscriptions.push(
    lenses,
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

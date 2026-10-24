import * as vscode from 'vscode';
import { registerCommands } from './vscode/commands';
import { createOutputLogger } from './vscode/logging';

// The composition root: services are created and wired here, nowhere else (ARCHITECTURE.md §10).
export function activate(context: vscode.ExtensionContext): void {
  const { logger, channel, disposables } = createOutputLogger();
  context.subscriptions.push(...disposables);
  context.subscriptions.push(...registerCommands({ logger, channel }));

  const version = (context.extension.packageJSON as { version?: string }).version ?? 'unknown';
  const mode = vscode.ExtensionMode[context.extensionMode].toLowerCase();
  logger.info(`DataNest ${version} activated (${mode})`);
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

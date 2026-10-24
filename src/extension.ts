import * as vscode from 'vscode';
import { CONTEXT_KEYS } from './vscode/command-ids';
import { registerCommands } from './vscode/commands';
import { createOutputLogger } from './vscode/logging';

// The composition root: services are created and wired here, nowhere else (ARCHITECTURE.md §10).
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const { logger, channel, disposables } = createOutputLogger();
  context.subscriptions.push(...disposables);
  context.subscriptions.push(
    ...registerCommands({ logger, channel, extensionUri: context.extensionUri }),
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

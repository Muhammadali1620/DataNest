import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import { COMMAND_IDS, type CommandId } from './command-ids';
import { guardCommand } from './command-runner';

export interface CommandDeps {
  readonly logger: Logger;
  readonly channel: vscode.OutputChannel;
}

/** Registers every command in one place; handlers are guarded against unhandled errors. */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const runner = {
    logger: deps.logger,
    showError: (message: string) =>
      vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', message)),
  };
  const handlers: Record<CommandId, () => unknown> = {
    [COMMAND_IDS.showLogs]: () => {
      deps.channel.show(true);
    },
  };
  return Object.entries(handlers).map(([id, handler]) =>
    vscode.commands.registerCommand(id, guardCommand(id, handler, runner)),
  );
}

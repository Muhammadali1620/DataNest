import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { COMMAND_IDS, type CommandId } from './command-ids';
import { guardCommand } from './command-runner';
import { connectionCommandHandlers } from './connection-commands';
import { ConnectionFormPanel } from './panels/connection-form-panel';
import { PingPanel } from './panels/ping-panel';

export interface CommandDeps {
  readonly logger: Logger;
  readonly channel: vscode.OutputChannel;
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
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
  let pings: PingPanel[] = [];
  const handlers: Record<CommandId, (id?: string) => unknown> = {
    [COMMAND_IDS.showLogs]: () => {
      deps.channel.show(true);
    },
    [COMMAND_IDS.addConnection]: connections.add,
    [COMMAND_IDS.editConnection]: connections.edit,
    [COMMAND_IDS.duplicateConnection]: connections.duplicate,
    [COMMAND_IDS.removeConnection]: connections.remove,
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
      },
    },
  ];
}

import * as vscode from 'vscode';
import { DbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { msg } from '../../core/user-message';
import { shellQuote } from '../../shared/shell-quote';
import type { SshServerConfig } from '../../shared/ssh-server';
import type { ServerStore } from '../../services/server-store';
import type { ShellOpener } from '../../services/shell-types';
import {
  DEFAULT_WINDOW,
  describeExecResult,
  OutputDecoder,
  specOfServer,
  TerminalController,
  type TerminalDeps,
  TerminalRegistry,
} from '../../services/ssh-terminal';
import type { HostKeyCheck } from '../../services/tunnels';
import { COLOR_THEME_IDS } from '../tree/connection-look';
import { folderOf, isServerNode } from './servers-tree';

export interface TerminalCommandDeps {
  readonly store: ServerStore;
  readonly opener: ShellOpener;
  readonly checkHostKey: HostKeyCheck;
  readonly logger: Logger;
  /** Open terminals per server, to keep their number within the limit. */
  readonly registry?: TerminalRegistry;
}

export type TerminalCommandName = 'openTerminal' | 'runCommand';

type Handler = (...args: unknown[]) => unknown;

/** A pseudo-terminal that shows the shell of a server; all behaviour is in the controller. */
export class ServerPty implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.written.event;
  readonly controller: TerminalController;

  constructor(open: TerminalDeps['open'], cwd: string | undefined, onClosed: () => void) {
    this.controller = new TerminalController({
      open,
      write: (text) => {
        this.written.fire(text);
      },
      ...(cwd === undefined ? {} : { cwd }),
      onClosed,
    });
  }

  open(initial: vscode.TerminalDimensions | undefined): void {
    void this.controller.start(
      initial === undefined ? DEFAULT_WINDOW : { cols: initial.columns, rows: initial.rows },
    );
  }

  close(): void {
    this.controller.close();
    this.written.dispose();
  }

  handleInput(data: string): void {
    this.controller.input(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.controller.resize({ cols: dimensions.columns, rows: dimensions.rows });
  }
}

export function terminalCommandHandlers(
  deps: TerminalCommandDeps,
): Record<TerminalCommandName, Handler> {
  const registry = deps.registry ?? new TerminalRegistry();
  const channels = new Map<string, vscode.OutputChannel>();
  const lastCommand = new Map<string, string>();

  const serverOf = (id: string): SshServerConfig => {
    const server = deps.store.get(id);
    if (server === undefined) {
      throw new DbError('not-found', msg('The server "{0}" does not exist', id));
    }
    return server;
  };

  /** Which server and folder a command was run on; asks when run from the palette. */
  const target = async (
    node: unknown,
    placeHolder: string,
  ): Promise<{ server: SshServerConfig; path: string | undefined } | undefined> => {
    if (isServerNode(node)) {
      const folder = folderOf(node);
      const server = serverOf(folder.serverId);
      return { server, path: folder.path ?? server.startPath };
    }
    const servers = deps.store.list();
    if (servers.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There are no saved servers yet'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      servers.map((server) => ({ label: server.name, id: server.id })),
      { placeHolder },
    );
    if (picked === undefined) {
      return undefined;
    }
    const server = serverOf(picked.id);
    return { server, path: server.startPath };
  };

  /**
   * A shell or a command can change anything, so a server marked read-only is not opened
   * for one without the user's say: the flag is DataNest's promise, which a shell would break.
   */
  const confirmShell = async (server: SshServerConfig): Promise<boolean> => {
    if (server.readOnly !== true) {
      return true;
    }
    const open = vscode.l10n.t('Continue');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        '"{0}" is marked read-only, but a shell can change anything on it.',
        server.name,
      ),
      {
        modal: true,
        detail: vscode.l10n.t(
          'DataNest keeps files on a read-only server from changing, but it cannot hold back what you type in a terminal or run as a command.',
        ),
      },
      open,
    );
    return answer === open;
  };

  const channelOf = (server: SshServerConfig): vscode.OutputChannel => {
    let channel = channels.get(server.id);
    if (channel === undefined) {
      channel = vscode.window.createOutputChannel(`DataNest: ${server.name}`);
      channels.set(server.id, channel);
    }
    return channel;
  };

  return {
    openTerminal: async (node?: unknown) => {
      const picked = await target(node, vscode.l10n.t('Pick a server to open a terminal on'));
      if (picked === undefined || !(await confirmShell(picked.server))) {
        return undefined;
      }
      const { server, path } = picked;
      const release = registry.claim(server.id, server.name);
      let terminal: vscode.Terminal;
      try {
        const pty = new ServerPty(
          async (window) =>
            await deps.opener.openShell(
              await specOfServer(deps.store, server.id, deps.checkHostKey),
              window,
            ),
          path,
          release,
        );
        terminal = vscode.window.createTerminal({
          name: path === undefined ? server.name : `${server.name}: ${lastSegment(path)}`,
          pty,
          iconPath: new vscode.ThemeIcon(
            'terminal',
            new vscode.ThemeColor(
              server.color === undefined ? 'foreground' : COLOR_THEME_IDS[server.color],
            ),
          ),
          ...(server.color === undefined
            ? {}
            : { color: new vscode.ThemeColor(COLOR_THEME_IDS[server.color]) }),
        });
      } catch (error) {
        release();
        throw error;
      }
      terminal.show();
      return undefined;
    },

    runCommand: async (node?: unknown) => {
      const picked = await target(node, vscode.l10n.t('Pick a server to run a command on'));
      if (picked === undefined) {
        return undefined;
      }
      const { server, path } = picked;
      const command = await vscode.window.showInputBox({
        title: vscode.l10n.t('Run a command on "{0}"', server.name),
        prompt:
          path === undefined
            ? vscode.l10n.t('The command runs in the login folder of the user')
            : vscode.l10n.t('The command runs in {0}', path),
        value: lastCommand.get(server.id) ?? '',
        ignoreFocusOut: true,
      });
      if (command === undefined || command.trim() === '') {
        return undefined;
      }
      if (!(await confirmShell(server))) {
        return undefined;
      }
      lastCommand.set(server.id, command);
      const channel = channelOf(server);
      channel.show(true);
      channel.appendLine(`$ ${command}`);
      const decoder = new OutputDecoder();
      const line = path === undefined ? command : `cd -- ${shellQuote(path)} && {\n${command}\n}`;
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Running on "{0}"…', server.name),
            cancellable: true,
          },
          async (_progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => {
              abort.abort();
            });
            return await deps.opener.execCommand(
              await specOfServer(deps.store, server.id, deps.checkHostKey),
              line,
              {
                signal: abort.signal,
                onData: (chunk, error) => {
                  channel.append(decoder.write(chunk, error));
                },
              },
            );
          },
        );
        channel.append(decoder.end());
        channel.appendLine(`\n[${describeExecResult(result)}]`);
      } catch (error) {
        channel.append(decoder.end());
        channel.appendLine(`\n[${error instanceof Error ? error.message : String(error)}]`);
        throw error;
      }
      return undefined;
    },
  };
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  const index = trimmed.lastIndexOf('/');
  const name = index === -1 ? trimmed : trimmed.slice(index + 1);
  return name === '' ? '/' : name;
}

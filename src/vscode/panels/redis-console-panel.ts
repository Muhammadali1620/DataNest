// The Redis console page (V7.4): one panel per console, with a connection of its own,
// so SELECT and MULTI there never move the tree or a key page. Results go to the page
// as they come; the host remembers the lines of each connection for the arrow keys.

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { RedisSession } from '../../drivers/redis-driver';
import { ConnectionManager } from '../../services/connection-manager';
import { loadCommandDocs } from '../../services/redis/command-docs';
import { type ConsoleQuestion, RedisConsole } from '../../services/redis/console';
import type { SafeMode } from '../../services/safe-mode';
import type { WritePolicy } from '../../services/write-policy';
import type { ConnectionConfig } from '../../shared/connection';
import { redisModeOf } from '../../shared/connection';
import {
  MAX_HISTORY,
  MAX_OUTPUT_LINES,
  type RedisConsoleProtocol,
  redisConsoleProtocol,
  type RedisConsoleState,
} from '../../shared/protocols/redis-console';
import { RpcPeer } from '../../shared/rpc';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface RedisConsolePanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly manager: Pick<ConnectionManager, 'acquireRedis' | 'release' | 'redisSessionOf'>;
  readonly config: ConnectionConfig;
  readonly database: number;
  readonly policy: WritePolicy;
  readonly safeMode: () => SafeMode;
}

/** The lines typed per connection, newest last; shared by its consoles. */
const histories = new Map<string, string[]>();

export class RedisConsolePanel implements vscode.Disposable {
  static readonly viewType = 'datanest.redisConsole';

  private static readonly open = new Set<RedisConsolePanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<RedisConsoleProtocol['host'], RedisConsoleProtocol['webview']>;
  private readonly log: Logger;
  private readonly owner = ConnectionManager.taskOwner(`redis-console:${randomUUID()}`);
  private readonly console: RedisConsole;
  /** The database SELECT moved to; the one the session reopens on after a lost link. */
  private database: number;
  private commands: RedisConsoleState['commands'] | undefined;
  private disposed = false;

  static show(deps: RedisConsolePanelDeps): RedisConsolePanel {
    const panel = new RedisConsolePanel(deps);
    RedisConsolePanel.open.add(panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...RedisConsolePanel.open]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: RedisConsolePanelDeps) {
    this.log = deps.logger.child('redis-console');
    this.database = deps.database;
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: RedisConsolePanel.viewType,
      title: this.title(),
      app: 'redis-console',
    });
    this.rpc = new RpcPeer({
      local: redisConsoleProtocol.host,
      remote: redisConsoleProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.console = new RedisConsole({
      session: async () => await this.session(),
      policy: deps.policy,
      safeMode: deps.safeMode,
      confirm: async (question) => await this.confirm(question),
      onDatabase: (database) => {
        this.database = database;
        this.panel.title = this.title();
        this.rpc.emit('database', { database });
      },
    });
    this.rpc.handle('run', async ({ text }) => {
      for (const line of text.split(/\r?\n/)) {
        const result = await this.console.run(line);
        if (result === undefined || this.disposed) {
          continue;
        }
        this.remember(result.command);
        const cut = result.lines.length > MAX_OUTPUT_LINES;
        this.rpc.emit('output', {
          command: result.command,
          lines: cut
            ? [
                ...result.lines.slice(0, MAX_OUTPUT_LINES),
                vscode.l10n.t('({0} more lines)', result.lines.length - MAX_OUTPUT_LINES),
              ]
            : [...result.lines],
          error: result.error,
          ...(result.ms === undefined ? {} : { ms: result.ms }),
        });
      }
      return {};
    });
    this.rpc.handle('completeKeys', async ({ prefix }) => ({
      keys: await this.console.completeKeys(prefix),
    }));
    this.rpc.handle('stop', async () => {
      await deps.manager.release(this.owner);
      return {};
    });
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      void this.sendState();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    RedisConsolePanel.open.delete(this);
    this.rpc.dispose();
    this.panel.dispose();
    void this.deps.manager.release(this.owner);
  }

  private title(): string {
    return vscode.l10n.t('Redis: {0} db{1}', this.deps.config.name, this.database);
  }

  /** The live session, or a new one on the database the console is in now. */
  private async session(): Promise<RedisSession> {
    const live = this.deps.manager.redisSessionOf(this.owner);
    if (live !== undefined) {
      return live;
    }
    return await this.deps.manager.acquireRedis(this.owner, {
      connectionId: this.deps.config.id,
      database: String(this.database),
    });
  }

  private async sendState(): Promise<void> {
    if (this.commands === undefined) {
      try {
        this.commands = (await loadCommandDocs(await this.session())).map((doc) => ({ ...doc }));
      } catch (error) {
        // The console still runs commands; it only cannot suggest them.
        this.log.warn('Could not read the command catalog', error);
        this.commands = [];
      }
    }
    if (this.disposed) {
      return;
    }
    this.rpc.emit('state', {
      connectionName: this.deps.config.name,
      database: this.database,
      mode: redisModeOf(this.deps.config),
      readOnly: this.deps.policy.readOnly,
      production: this.deps.policy.production,
      commands: this.commands,
      history: [...(histories.get(this.deps.config.id) ?? [])],
    });
  }

  private remember(command: string): void {
    const history = histories.get(this.deps.config.id) ?? [];
    if (history.at(-1) !== command) {
      history.push(command);
    }
    histories.set(this.deps.config.id, history.slice(-MAX_HISTORY));
  }

  private async confirm(question: ConsoleQuestion): Promise<boolean> {
    const run = vscode.l10n.t('Run');
    const message =
      question.kind === 'dangerous'
        ? vscode.l10n.t('Run "{0}"? It can change or stop the whole server.', question.command)
        : vscode.l10n.t(
            'Run "{0}" on the production connection "{1}"?',
            question.command,
            this.deps.policy.name,
          );
    const detail =
      question.kind === 'dangerous' && question.production
        ? vscode.l10n.t('"{0}" is a production connection.', this.deps.policy.name)
        : undefined;
    const answer = await vscode.window.showWarningMessage(
      message,
      { modal: true, ...(detail === undefined ? {} : { detail }) },
      run,
    );
    return answer === run;
  }
}

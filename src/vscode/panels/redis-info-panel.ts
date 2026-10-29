// Redis server information (V7.4): one panel per connection, read from the server, or
// from every master of a cluster, whenever the page asks.

import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { RedisSession } from '../../drivers/redis-driver';
import { readServerInfo } from '../../services/redis/server-info';
import type { ConnectionConfig } from '../../shared/connection';
import { describeTarget } from '../../shared/connection';
import { type RedisInfoProtocol, redisInfoProtocol } from '../../shared/protocols/redis-info';
import { RpcPeer } from '../../shared/rpc';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface RedisInfoPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly config: ConnectionConfig;
  readonly session: () => Promise<RedisSession>;
}

export class RedisInfoPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.redisInfo';

  private static readonly open = new Map<string, RedisInfoPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<RedisInfoProtocol['host'], RedisInfoProtocol['webview']>;
  private readonly log: Logger;
  private disposed = false;

  static show(deps: RedisInfoPanelDeps): RedisInfoPanel {
    const existing = RedisInfoPanel.open.get(deps.config.id);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new RedisInfoPanel(deps);
    RedisInfoPanel.open.set(deps.config.id, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...RedisInfoPanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: RedisInfoPanelDeps) {
    this.log = deps.logger.child('redis-info');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: RedisInfoPanel.viewType,
      title: vscode.l10n.t('Server: {0}', deps.config.name),
      app: 'redis-info',
    });
    this.rpc = new RpcPeer({
      local: redisInfoProtocol.host,
      remote: redisInfoProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('refresh', async () => {
      await this.read();
      return {};
    });
    this.rpc.on('ready', () => {
      void this.read().catch((error: unknown) => {
        this.log.warn('Reading INFO failed', error);
        void vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', errorMessage(error)));
      });
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
    RedisInfoPanel.open.delete(this.deps.config.id);
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async read(): Promise<void> {
    const nodes = await readServerInfo(await this.deps.session(), (index, count) =>
      count === 1 ? describeTarget(this.deps.config) : vscode.l10n.t('master {0}', index + 1),
    );
    if (!this.disposed) {
      this.rpc.emit('state', {
        connectionName: this.deps.config.name,
        nodes: nodes.map((node) => ({
          name: node.name,
          sections: node.sections.map((section) => ({
            name: section.name,
            fields: section.fields.map(([name, value]) => [name, value]),
          })),
          summary: node.summary,
        })),
        at: Date.now(),
      });
    }
  }
}

// The server monitor page (V8.5): one panel per connection, reading with a session of
// its own, so a busy editor never holds it up. Stopping a session asks first.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { RpcPeer } from '../../shared/rpc';
import {
  serverMonitorProtocol,
  type ServerMonitorProtocol,
} from '../../shared/protocols/server-monitor';
import type { ServerMonitorModel } from './server-monitor-model';
import { confirmStop } from './stop-confirm';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ServerMonitorPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: ServerMonitorModel;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly production: boolean;
  /** Closes the monitor's session. */
  readonly release: () => Promise<void>;
}

export class ServerMonitorPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.serverMonitor';

  private static readonly open = new Map<string, ServerMonitorPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ServerMonitorProtocol['host'], ServerMonitorProtocol['webview']>;
  private readonly log: Logger;
  private starting: Promise<void> | undefined;
  private disposed = false;

  static show(deps: ServerMonitorPanelDeps): ServerMonitorPanel {
    const existing = ServerMonitorPanel.open.get(deps.connectionId);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new ServerMonitorPanel(deps);
    ServerMonitorPanel.open.set(deps.connectionId, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...ServerMonitorPanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: ServerMonitorPanelDeps) {
    this.log = deps.logger.child('server-monitor');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ServerMonitorPanel.viewType,
      title: vscode.l10n.t('Monitor: {0}', deps.connectionName),
      app: 'server-monitor',
    });
    this.rpc = new RpcPeer({
      local: serverMonitorProtocol.host,
      remote: serverMonitorProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    const { model } = deps;
    this.rpc.handle('processes', async () => await model.processes());
    this.rpc.handle('settings', async ({ scope }) => ({ rows: await model.settings(scope) }));
    this.rpc.handle('status', async () => await model.status());
    this.rpc.handle('stop', async ({ id, kind }) => {
      const process = model.process(id);
      if (
        process !== undefined &&
        !(await confirmStop(process, kind, {
          name: this.deps.connectionName,
          production: this.deps.production,
        }))
      ) {
        return { stopped: false };
      }
      const stopped = await model.stop(id, kind);
      if (!stopped) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('The process {0} had already finished', id),
        );
      }
      return { stopped };
    });
    this.rpc.on('ready', () => {
      void this.sendState();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private async sendState(): Promise<void> {
    if (!this.deps.model.started) {
      this.starting ??= this.deps.model.start();
      await this.starting;
    }
    if (!this.disposed) {
      this.rpc.emit('state', this.deps.model.state());
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ServerMonitorPanel.open.delete(this.deps.connectionId);
    this.rpc.dispose();
    this.panel.dispose();
    void this.deps.release().catch((error: unknown) => {
      this.log.warn('Closing the monitor session failed', error);
    });
  }
}

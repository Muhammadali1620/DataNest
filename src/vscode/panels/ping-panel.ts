import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { pingProtocol, type PingProtocol } from '../../shared/protocols/ping';
import { RpcPeer } from '../../shared/rpc';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

/** What the openPing command returns; e2e tests use it to check both RPC directions. */
export interface PingPanelHandle {
  /** Resolves when the page script has started and subscribed to messages. */
  readonly ready: Promise<void>;
  echo(text: string): Promise<string>;
  readonly isDisposed: boolean;
  dispose(): void;
}

/** The diagnostic page: webview under our CSP + RPC in both directions. */
export class PingPanel implements PingPanelHandle, vscode.Disposable {
  static readonly viewType = 'datanest.ping';

  readonly ready: Promise<void>;
  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<PingProtocol['host'], PingProtocol['webview']>;
  private count = 0;
  private disposed = false;

  constructor(extensionUri: vscode.Uri, logger: Logger) {
    const log = logger.child('ping');
    this.panel = createWebviewAppPanel(extensionUri, {
      viewType: PingPanel.viewType,
      title: vscode.l10n.t('DataNest Ping'),
      app: 'ping',
    });
    this.rpc = new RpcPeer({
      local: pingProtocol.host,
      remote: pingProtocol.webview,
      transport: webviewTransport(this.panel.webview, log),
      onProtocolError: (problem) => {
        log.warn(problem);
      },
    });
    this.rpc.handle('ping', ({ text }) => {
      this.count += 1;
      log.debug(`ping #${this.count}`);
      return { reply: text, count: this.count };
    });
    this.ready = new Promise((resolve) => {
      this.rpc.on('ready', () => {
        log.info('Webview is ready');
        this.rpc.emit('notice', { text: vscode.l10n.t('Connected to the extension host') });
        resolve();
      });
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async echo(text: string): Promise<string> {
    return (await this.rpc.request('echo', { text })).text;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rpc.dispose();
    this.panel.dispose();
  }
}

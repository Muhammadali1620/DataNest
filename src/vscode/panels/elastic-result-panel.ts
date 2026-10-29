// The result page of Elasticsearch requests (V7.8): one panel per query editor, beside
// it, each run replacing what it showed. Copies go to the clipboard from here.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import {
  type ElasticResultProtocol,
  elasticResultProtocol,
  type ElasticResultState,
} from '../../shared/protocols/elastic-result';
import { RpcPeer } from '../../shared/rpc';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ElasticResultPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  /** The editor whose results the panel shows. */
  readonly key: string;
  readonly title: string;
  readonly state: ElasticResultState;
  /** The whole answer and each hit as text, for copies. */
  readonly copyText: (rows: readonly number[] | undefined) => string;
}

export class ElasticResultPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.elasticResult';

  private static readonly open = new Map<string, ElasticResultPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ElasticResultProtocol['host'], ElasticResultProtocol['webview']>;
  private deps: ElasticResultPanelDeps;
  private disposed = false;

  static show(deps: ElasticResultPanelDeps): ElasticResultPanel {
    const existing = ElasticResultPanel.open.get(deps.key);
    if (existing !== undefined && !existing.disposed) {
      existing.deps = deps;
      existing.panel.title = deps.title;
      existing.rpc.emit('state', deps.state);
      existing.panel.reveal(undefined, true);
      return existing;
    }
    const panel = new ElasticResultPanel(deps);
    ElasticResultPanel.open.set(deps.key, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...ElasticResultPanel.open.values()]) {
      panel.dispose();
    }
    ElasticResultPanel.open.clear();
  }

  private constructor(deps: ElasticResultPanelDeps) {
    this.deps = deps;
    const log = deps.logger.child('elastic-result');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ElasticResultPanel.viewType,
      title: deps.title,
      app: 'elastic-result',
      column: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
    this.rpc = new RpcPeer({
      local: elasticResultProtocol.host,
      remote: elasticResultProtocol.webview,
      transport: webviewTransport(this.panel.webview, log),
      onProtocolError: (problem) => {
        log.warn(problem);
      },
    });
    this.rpc.handle('copy', async ({ rows }) => {
      await vscode.env.clipboard.writeText(this.deps.copyText(rows));
      return {};
    });
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      this.rpc.emit('state', this.deps.state);
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
    ElasticResultPanel.open.delete(this.deps.key);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

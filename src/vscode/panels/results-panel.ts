import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { QueryRunner } from '../../services/query-runner';
import type { ResultStore } from '../../services/result-store';
import { resultGridProtocol, type ResultGridProtocol } from '../../shared/protocols/result-grid';
import { RpcPeer } from '../../shared/rpc';
import { buildState } from './results-state';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ResultsPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly results: ResultStore;
  readonly runner: QueryRunner;
  readonly logger: Logger;
}

/**
 * One panel per SQL document, beside the editor. It is created on the first run
 * and reused afterwards; closing it is harmless, the next run opens it again.
 */
export class ResultsPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.results';

  private static readonly open = new Map<string, ResultsPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly deps: ResultsPanelDeps;
  private readonly rpc: RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly documentUri: string;
  private activeId: string | undefined;
  private disposed = false;

  /** Shows the results of a document, creating the panel when needed. */
  static show(deps: ResultsPanelDeps, documentUri: string): ResultsPanel {
    const existing = ResultsPanel.open.get(documentUri);
    if (existing && !existing.disposed) {
      existing.reveal();
      existing.update();
      return existing;
    }
    const panel = new ResultsPanel(deps, documentUri);
    ResultsPanel.open.set(documentUri, panel);
    return panel;
  }

  /** The panel of a document, if it is open. */
  static find(documentUri: string): ResultsPanel | undefined {
    const panel = ResultsPanel.open.get(documentUri);
    return panel?.disposed === false ? panel : undefined;
  }

  static disposeAll(): void {
    for (const panel of [...ResultsPanel.open.values()]) {
      panel.dispose();
    }
    ResultsPanel.open.clear();
  }

  private constructor(deps: ResultsPanelDeps, documentUri: string) {
    this.deps = deps;
    this.documentUri = documentUri;
    const log = deps.logger.child('results');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ResultsPanel.viewType,
      title: vscode.l10n.t('Results'),
      app: 'result-grid',
      column: vscode.ViewColumn.Beside,
      // Results appear next to the query; the cursor stays in the editor.
      preserveFocus: true,
    });
    this.rpc = new RpcPeer({
      local: resultGridProtocol.host,
      remote: resultGridProtocol.webview,
      transport: webviewTransport(this.panel.webview, log),
      onProtocolError: (problem) => {
        log.warn(problem);
      },
    });
    this.rpc.handle('rows', ({ resultId, offset, limit }) => {
      const window = this.deps.results.window(resultId, offset, limit);
      if (window === undefined) {
        // The result is gone (a newer run replaced it); an empty window is honest.
        return { resultId, offset, rows: [], rowCount: 0 };
      }
      return {
        resultId,
        offset: window.offset,
        rows: window.rows.map((row) => [...row]),
        rowCount: window.rowCount,
      };
    });
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      this.update();
    });
    this.rpc.on('selectTab', ({ resultId }) => {
      this.activeId = resultId;
    });
    this.rpc.on('cancel', () => {
      void this.deps.runner.cancel(this.documentUri);
    });
    this.rpc.on('copyText', ({ text }) => {
      void vscode.env.clipboard.writeText(text);
    });
    this.subscriptions.push(
      deps.results.onDidChange((documentUri) => {
        if (documentUri === this.documentUri) {
          this.update();
        }
      }),
      deps.runner.onDidChangeRunning((documentUri) => {
        if (documentUri === this.documentUri) {
          this.update();
        }
      }),
    );
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Brings the panel forward without stealing focus from the editor. */
  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  update(): void {
    if (this.disposed) {
      return;
    }
    const summaries = this.deps.results.forDocument(this.documentUri);
    const state = buildState(
      summaries,
      this.activeId,
      this.deps.runner.isRunning(this.documentUri),
    );
    this.activeId = state.activeId;
    this.rpc.emit('state', state);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    for (const [key, panel] of ResultsPanel.open) {
      if (panel === this) {
        ResultsPanel.open.delete(key);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }
}

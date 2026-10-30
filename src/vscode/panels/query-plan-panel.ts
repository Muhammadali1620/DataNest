// The query plan page (V8.2): one panel per SQL editor, beside it. Explaining again
// from the editor reuses the panel with the new statement.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { RpcPeer } from '../../shared/rpc';
import { queryPlanProtocol, type QueryPlanProtocol } from '../../shared/protocols/query-plan';
import type { QueryPlanModel } from './query-plan-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface QueryPlanPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly documentUri: string;
  /** Makes the model when the editor has no plan panel yet. */
  readonly model: () => QueryPlanModel;
  readonly statement: string;
  readonly analyze: boolean;
  /** Stops the run of the editor, which the plan is part of. */
  readonly cancel: () => Promise<void>;
}

export class QueryPlanPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.queryPlan';

  private static readonly open = new Map<string, QueryPlanPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<QueryPlanProtocol['host'], QueryPlanProtocol['webview']>;
  private readonly model: QueryPlanModel;
  private disposed = false;

  /** Shows the plan of `statement`, in the editor's panel if it has one. */
  static show(deps: QueryPlanPanelDeps): QueryPlanPanel {
    const existing = QueryPlanPanel.open.get(deps.documentUri);
    if (existing !== undefined) {
      existing.panel.reveal(undefined, true);
      existing.model.setStatement(deps.statement);
      void existing.run(deps.analyze);
      return existing;
    }
    const panel = new QueryPlanPanel(deps);
    QueryPlanPanel.open.set(deps.documentUri, panel);
    void panel.run(deps.analyze);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...QueryPlanPanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: QueryPlanPanelDeps) {
    const log = deps.logger.child('query-plan');
    this.model = deps.model();
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: QueryPlanPanel.viewType,
      title: vscode.l10n.t('Query Plan'),
      app: 'query-plan',
      column: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
    this.rpc = new RpcPeer({
      local: queryPlanProtocol.host,
      remote: queryPlanProtocol.webview,
      transport: webviewTransport(this.panel.webview, log),
      onProtocolError: (problem) => {
        log.warn(problem);
      },
    });
    this.rpc.on('ready', () => {
      this.send();
    });
    this.rpc.on('explain', ({ analyze }) => {
      void this.run(analyze);
    });
    this.rpc.on('showRaw', () => {
      void this.showRaw();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private async run(analyze: boolean): Promise<void> {
    if (this.model.isRunning) {
      return;
    }
    const running = this.model.run(analyze);
    this.send();
    await running;
    this.send();
  }

  private send(): void {
    if (!this.disposed) {
      this.rpc.emit('state', this.model.state());
    }
  }

  private async showRaw(): Promise<void> {
    const raw = this.model.raw();
    if (raw === undefined) {
      return;
    }
    const document = await vscode.workspace.openTextDocument({
      content: raw.text,
      language: raw.language,
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.model.isRunning) {
      void this.deps.cancel();
    }
    QueryPlanPanel.open.delete(this.deps.documentUri);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

// The chart of a query result (V8.7): one panel per result, beside the results. The
// rows are copied when it opens, so later runs and edits do not change the picture.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { RpcPeer } from '../../shared/rpc';
import { resultChartProtocol, type ResultChartProtocol } from '../../shared/protocols/result-chart';
import type { ResultChartModel } from './result-chart-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ResultChartPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: ResultChartModel;
  readonly key: string;
  readonly title: string;
}

export class ResultChartPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.resultChart';

  private static readonly open = new Map<string, ResultChartPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ResultChartProtocol['host'], ResultChartProtocol['webview']>;
  private readonly log: Logger;
  private disposed = false;

  static show(deps: ResultChartPanelDeps): ResultChartPanel {
    const existing = ResultChartPanel.open.get(deps.key);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new ResultChartPanel(deps);
    ResultChartPanel.open.set(deps.key, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...ResultChartPanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: ResultChartPanelDeps) {
    this.log = deps.logger.child('result-chart');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ResultChartPanel.viewType,
      title: deps.title,
      app: 'result-chart',
    });
    this.rpc = new RpcPeer({
      local: resultChartProtocol.host,
      remote: resultChartProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('configure', ({ config }) => ({ data: deps.model.configure(config) }));
    this.rpc.handle('save', async ({ format, data }) => ({ saved: await this.save(format, data) }));
    this.rpc.on('ready', () => {
      if (!this.disposed) {
        this.rpc.emit('state', deps.model.state());
      }
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private async save(format: 'svg' | 'png', data: string): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const name = `chart.${format}`;
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Save the Chart'),
      defaultUri: folder === undefined ? vscode.Uri.file(name) : vscode.Uri.joinPath(folder, name),
      filters: format === 'svg' ? { SVG: ['svg'] } : { PNG: ['png'] },
    });
    if (target === undefined) {
      return false;
    }
    const bytes =
      format === 'svg'
        ? Buffer.from(data, 'utf8')
        : Buffer.from(data.replace(/^data:[^,]*,/u, ''), 'base64');
    await vscode.workspace.fs.writeFile(target, bytes);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The chart was saved to {0}', target.fsPath),
    );
    return true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ResultChartPanel.open.delete(this.deps.key);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

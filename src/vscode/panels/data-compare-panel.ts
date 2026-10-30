// The data comparison page (V8.4): one panel per pair of tables. The comparison runs
// in the host with progress on the page; closing the page or Stop cancels it.

import type * as vscode from 'vscode';
import { isDbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { RpcPeer } from '../../shared/rpc';
import { dataCompareProtocol, type DataCompareProtocol } from '../../shared/protocols/data-compare';
import type { DataCompareModel } from './data-compare-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface DataComparePanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: DataCompareModel;
  readonly key: string;
  readonly title: string;
  /** Opens the sync script in an editor on the target table's connection. */
  readonly openScript: (text: string) => Promise<void>;
}

const PROGRESS_INTERVAL_MS = 200;

export class DataComparePanel implements vscode.Disposable {
  static readonly viewType = 'datanest.dataCompare';

  private static readonly open = new Map<string, DataComparePanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<DataCompareProtocol['host'], DataCompareProtocol['webview']>;
  private readonly log: Logger;
  private abort: AbortController | undefined;
  private disposed = false;

  static show(deps: DataComparePanelDeps): DataComparePanel {
    const existing = DataComparePanel.open.get(deps.key);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new DataComparePanel(deps);
    DataComparePanel.open.set(deps.key, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...DataComparePanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: DataComparePanelDeps) {
    this.log = deps.logger.child('data-compare');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: DataComparePanel.viewType,
      title: deps.title,
      app: 'data-compare',
    });
    this.rpc = new RpcPeer({
      local: dataCompareProtocol.host,
      remote: dataCompareProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('rows', ({ kind, offset, limit }) => ({
      rows: deps.model.rows(kind, offset, limit),
    }));
    this.rpc.handle('openScript', async (include) => {
      await deps.openScript(deps.model.script(include));
      return { opened: true };
    });
    this.rpc.on('ready', () => {
      if (deps.model.loaded || this.abort !== undefined) {
        this.send();
      } else {
        void this.run();
      }
    });
    this.rpc.on('refresh', () => {
      if (this.abort === undefined) {
        void this.run();
      }
    });
    this.rpc.on('cancel', () => {
      this.abort?.abort();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private async run(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    let shownAt = 0;
    const running = this.deps.model.run({
      signal: abort.signal,
      onProgress: (state) => {
        const now = Date.now();
        if (now - shownAt >= PROGRESS_INTERVAL_MS && !this.disposed) {
          shownAt = now;
          this.rpc.emit('state', state);
        }
      },
    });
    this.send();
    try {
      await running;
    } catch (error) {
      if (!(isDbError(error) && error.code === 'cancelled')) {
        this.log.warn('Comparing the data failed', error);
      }
    } finally {
      this.abort = undefined;
    }
    this.send();
  }

  private send(): void {
    if (!this.disposed) {
      this.rpc.emit('state', this.deps.model.state());
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abort?.abort();
    DataComparePanel.open.delete(this.deps.key);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

// The schema comparison page (V8.3): one panel per pair of schemas. Reading both can
// take a while on big schemas, so the page shows how far it got; closing it stops.

import type * as vscode from 'vscode';
import { isDbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { RpcPeer } from '../../shared/rpc';
import {
  schemaCompareProtocol,
  type SchemaCompareProtocol,
} from '../../shared/protocols/schema-compare';
import type { CompareSide, SchemaCompareModel } from './schema-compare-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface SchemaComparePanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: SchemaCompareModel;
  readonly key: string;
  readonly title: string;
  /** Forgets cached structure of both connections, so Refresh reads them again. */
  readonly invalidate: () => void;
  /** Opens the script in an editor bound to the schema it changes. */
  readonly openScript: (text: string, target: CompareSide) => Promise<void>;
}

const PROGRESS_INTERVAL_MS = 150;

export class SchemaComparePanel implements vscode.Disposable {
  static readonly viewType = 'datanest.schemaCompare';

  private static readonly open = new Map<string, SchemaComparePanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<SchemaCompareProtocol['host'], SchemaCompareProtocol['webview']>;
  private readonly log: Logger;
  private abort: AbortController | undefined;
  private disposed = false;

  static show(deps: SchemaComparePanelDeps): SchemaComparePanel {
    const existing = SchemaComparePanel.open.get(deps.key);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new SchemaComparePanel(deps);
    SchemaComparePanel.open.set(deps.key, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...SchemaComparePanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: SchemaComparePanelDeps) {
    this.log = deps.logger.child('schema-compare');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: SchemaComparePanel.viewType,
      title: deps.title,
      app: 'schema-compare',
    });
    this.rpc = new RpcPeer({
      local: schemaCompareProtocol.host,
      remote: schemaCompareProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('detail', ({ id }) => deps.model.detail(id));
    this.rpc.handle('openScript', async ({ ids }) => {
      await deps.openScript(deps.model.script(ids), deps.model.targetSide);
      return { opened: true };
    });
    this.rpc.on('ready', () => {
      if (deps.model.loaded || this.abort !== undefined) {
        this.send();
      } else {
        void this.load();
      }
    });
    this.rpc.on('refresh', () => {
      if (this.abort === undefined) {
        deps.invalidate();
        void this.load();
      }
    });
    this.rpc.on('swap', () => {
      if (this.abort === undefined) {
        deps.model.swap();
        void this.load();
      }
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private async load(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    let shownAt = 0;
    try {
      await this.deps.model.load({
        signal: abort.signal,
        onProgress: (state) => {
          const now = Date.now();
          if (now - shownAt >= PROGRESS_INTERVAL_MS && !this.disposed) {
            shownAt = now;
            this.rpc.emit('state', state);
          }
        },
      });
    } catch (error) {
      if (!(isDbError(error) && error.code === 'cancelled')) {
        this.log.warn('Comparing the schemas failed', error);
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
    SchemaComparePanel.open.delete(this.deps.key);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

// The ER diagram page (V8.1): one panel per scope (or per set of chosen tables).
// The host reads the tables with progress on the page, keeps the box positions for
// a reloaded page (D21) and saves the pictures the page draws.

import * as vscode from 'vscode';
import { errorMessage, isDbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { TableRef } from '../../core/model/objects';
import { RpcPeer } from '../../shared/rpc';
import { erDiagramProtocol, type ErDiagramProtocol } from '../../shared/protocols/er-diagram';
import type { ErDiagramModel } from './er-diagram-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ErDiagramPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: ErDiagramModel;
  /** Identifies the diagram, so showing it again brings back the open panel. */
  readonly key: string;
  /** `shop.public`, for the title and file names. */
  readonly title: string;
  /** Forgets cached structure, so Refresh reads the server again. */
  readonly invalidate: () => void;
  readonly openTable: (table: TableRef) => Promise<void>;
}

const PROGRESS_INTERVAL_MS = 150;

export class ErDiagramPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.erDiagram';

  private static readonly open = new Map<string, ErDiagramPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ErDiagramProtocol['host'], ErDiagramProtocol['webview']>;
  private readonly log: Logger;
  private abort: AbortController | undefined;
  private failure: string | undefined;
  private disposed = false;

  static show(deps: ErDiagramPanelDeps): ErDiagramPanel {
    const existing = ErDiagramPanel.open.get(deps.key);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new ErDiagramPanel(deps);
    ErDiagramPanel.open.set(deps.key, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...ErDiagramPanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: ErDiagramPanelDeps) {
    this.log = deps.logger.child('er-diagram');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ErDiagramPanel.viewType,
      title: vscode.l10n.t('ER Diagram: {0}', deps.title),
      app: 'er-diagram',
    });
    this.rpc = new RpcPeer({
      local: erDiagramProtocol.host,
      remote: erDiagramProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('save', async ({ format, data }) => ({ saved: await this.save(format, data) }));
    this.rpc.on('ready', () => {
      if (this.failure !== undefined) {
        this.rpc.emit('failed', { message: this.failure });
      } else if (deps.model.loaded) {
        this.rpc.emit('state', deps.model.state());
      } else if (this.abort === undefined) {
        void this.load();
      }
    });
    this.rpc.on('positions', ({ positions }) => {
      deps.model.setPositions(positions);
    });
    this.rpc.on('details', ({ details }) => {
      deps.model.setDetails(details);
    });
    this.rpc.on('refresh', () => {
      if (this.abort === undefined) {
        deps.invalidate();
        void this.load();
      }
    });
    this.rpc.on('openTable', ({ id }) => {
      const table = deps.model.tableOf(id);
      if (table !== undefined) {
        void this.openTable(table);
      }
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private async load(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.failure = undefined;
    let shownAt = 0;
    try {
      const state = await this.deps.model.load({
        signal: abort.signal,
        onProgress: (done, total) => {
          const now = Date.now();
          if (now - shownAt >= PROGRESS_INTERVAL_MS && !this.disposed) {
            shownAt = now;
            this.rpc.emit('loading', { done, total });
          }
        },
      });
      if (!this.disposed) {
        this.rpc.emit('state', state);
      }
    } catch (error) {
      if (isDbError(error) && error.code === 'cancelled') {
        return;
      }
      this.log.warn('Could not read the tables for the diagram', error);
      this.failure = errorMessage(error);
      if (!this.disposed) {
        this.rpc.emit('failed', { message: this.failure });
      }
    } finally {
      this.abort = undefined;
    }
  }

  private async save(format: 'svg' | 'png', data: string): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const name = `${safeFileName(this.deps.title)}-er.${format}`;
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Save the ER Diagram'),
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
      vscode.l10n.t('The diagram was saved to {0}', target.fsPath),
    );
    return true;
  }

  private async openTable(table: TableRef): Promise<void> {
    try {
      await this.deps.openTable(table);
    } catch (error) {
      this.log.warn('Could not open the table from the diagram', error);
      void vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', errorMessage(error)));
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abort?.abort();
    ErDiagramPanel.open.delete(this.deps.key);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

/** Keeps letters of any language; drops what file systems refuse. */
function safeFileName(name: string): string {
  const safe = name
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-')
    .replace(/^[\s.-]+|[\s.-]+$/gu, '')
    .slice(0, 60);
  return safe === '' ? 'diagram' : safe;
}

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { RpcPeer } from '../../shared/rpc';
import {
  tableDesignerProtocol,
  type TableDesignerProtocol,
} from '../../shared/protocols/table-designer';
import { TableDesignerModel, type TableDesignerModelDeps } from './table-designer-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface TableDesignerPanelDeps extends TableDesignerModelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
}

/** The designer of a new table. Each "New Table…" opens its own panel. */
export class TableDesignerPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.tableDesigner';

  private static readonly open = new Set<TableDesignerPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<TableDesignerProtocol['host'], TableDesignerProtocol['webview']>;
  private readonly model: TableDesignerModel;
  private disposed = false;

  static show(deps: TableDesignerPanelDeps): TableDesignerPanel {
    const panel = new TableDesignerPanel(deps);
    TableDesignerPanel.open.add(panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...TableDesignerPanel.open]) {
      panel.dispose();
    }
  }

  private constructor(deps: TableDesignerPanelDeps) {
    const log = deps.logger.child('table-designer');
    this.model = new TableDesignerModel(deps);
    const scope = this.model.scopeLabel;
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: TableDesignerPanel.viewType,
      title: scope === '' ? vscode.l10n.t('New Table') : vscode.l10n.t('New Table in {0}', scope),
      app: 'table-designer',
    });
    this.rpc = new RpcPeer({
      local: tableDesignerProtocol.host,
      remote: tableDesignerProtocol.webview,
      transport: webviewTransport(this.panel.webview, log),
      onProtocolError: (problem) => {
        log.warn(problem);
      },
    });
    this.rpc.handle('preview', (design) => this.model.preview(design));
    this.rpc.handle('tables', async () => await this.model.tables());
    this.rpc.handle('columns', async ({ table }) => await this.model.columns(table));
    this.rpc.handle('save', async (design) => {
      const result = await this.model.save(design);
      if (result.outcome === 'ran') {
        // The table exists now; its structure lives in the tree from here on.
        this.dispose();
      }
      return result;
    });
    this.rpc.on('ready', () => {
      this.rpc.emit('state', this.model.state());
    });
    this.rpc.on('close', () => {
      this.dispose();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    TableDesignerPanel.open.delete(this);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

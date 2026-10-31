import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
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

/**
 * The table designer. Each "New Table…" opens a panel of its own; "Edit Table…"
 * brings back the panel of that table when it is already open.
 */
export class TableDesignerPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.tableDesigner';

  private static readonly open = new Set<TableDesignerPanel>();

  /** Identifies the edited table across panels; new tables have none. */
  private key: string | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<TableDesignerProtocol['host'], TableDesignerProtocol['webview']>;
  private readonly model: TableDesignerModel;
  private disposed = false;

  static show(deps: TableDesignerPanelDeps): TableDesignerPanel {
    const key = deps.table === undefined ? undefined : keyOf(deps, deps.table);
    const existing = [...TableDesignerPanel.open].find(
      (panel) => panel.key !== undefined && panel.key === key,
    );
    if (existing !== undefined) {
      existing.panel.reveal();
      if (deps.tab !== undefined) {
        existing.rpc.emit('tab', { tab: deps.tab });
      }
      return existing;
    }
    const panel = new TableDesignerPanel(deps);
    TableDesignerPanel.open.add(panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...TableDesignerPanel.open]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: TableDesignerPanelDeps) {
    const log = deps.logger.child('table-designer');
    this.model = new TableDesignerModel(deps);
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: TableDesignerPanel.viewType,
      title: this.title(),
      app: 'table-designer',
    });
    this.key = deps.table === undefined ? undefined : keyOf(deps, deps.table);
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
    this.rpc.handle('definition', async () => await this.model.definition());
    this.rpc.handle('triggers', async () => await this.model.triggers());
    this.rpc.handle(
      'triggerAction',
      async ({ action, name }) => await this.model.triggerAction(action, name),
    );
    this.rpc.handle('checks', async () => await this.model.checks());
    this.rpc.handle(
      'checkAction',
      async ({ action, name, expression }) =>
        await this.model.checkAction(action, name, expression),
    );
    this.rpc.handle('textAction', async ({ action, text }) => {
      await this.model.textAction(action, text);
      return {};
    });
    this.rpc.handle('save', async (design) => {
      const result = await this.model.save(design);
      if (result.outcome === 'ran') {
        // The table now is what was saved: show it as stored, under its new name.
        const name = this.model.tableName;
        this.key = name === undefined ? undefined : keyOf(deps, name);
        this.panel.title = this.title();
        await this.sendState();
      }
      return result;
    });
    this.rpc.on('ready', () => {
      void this.sendState();
    });
    this.rpc.on('close', () => {
      this.dispose();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private title(): string {
    const scope = this.model.scopeLabel;
    const name = this.model.tableName;
    if (name !== undefined) {
      return vscode.l10n.t('Properties {0}', scope === '' ? name : `${scope}.${name}`);
    }
    return scope === '' ? vscode.l10n.t('New Table') : vscode.l10n.t('New Table in {0}', scope);
  }

  /** Loading an existing table can fail (it was dropped meanwhile); the user is told why. */
  private async sendState(): Promise<void> {
    try {
      const state = await this.model.state();
      if (!this.disposed) {
        this.rpc.emit('state', state);
      }
    } catch (error) {
      this.deps.logger.warn('Could not load the table for the designer', error);
      void vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', errorMessage(error)));
      this.dispose();
    }
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

function keyOf(deps: TableDesignerPanelDeps, table: string): string {
  return JSON.stringify([
    deps.connectionId,
    deps.scope.database ?? '',
    deps.scope.schema ?? '',
    table,
  ]);
}

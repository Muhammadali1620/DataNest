// The documents page of a MongoDB collection (V7.6): one panel per collection, and one
// per query editor for the results of its statements (V7.7). It asks before every change
// on a production connection and always before a delete, and puts documents on the
// clipboard as text.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { changeVerdict, type WritePolicy } from '../../services/write-policy';
import { RpcPeer } from '../../shared/rpc';
import {
  type MongoDocumentsProtocol,
  mongoDocumentsProtocol,
  type MongoDocumentsState,
} from '../../shared/protocols/mongo-documents';
import type { DocumentsPage } from './mongo-documents-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface MongoDocumentsPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly model: DocumentsPage;
  readonly policy: WritePolicy;
  /**
   * Names the panel when it is not a collection's own page: the results of an editor are
   * shown in one panel beside it, each run replacing the last.
   */
  readonly results?: { readonly key: string; readonly title: string };
}

export class MongoDocumentsPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.mongoDocuments';

  private static readonly open = new Map<string, MongoDocumentsPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<MongoDocumentsProtocol['host'], MongoDocumentsProtocol['webview']>;
  private readonly log: Logger;
  private state: MongoDocumentsState | undefined;
  private model: DocumentsPage;
  private disposed = false;

  /**
   * Opens the page of a collection, or brings its open page forward; results replace
   * what their panel showed.
   */
  static show(deps: MongoDocumentsPanelDeps): MongoDocumentsPanel {
    const id =
      deps.results === undefined
        ? MongoDocumentsPanel.idOf(deps.connectionId, deps.database, deps.collection)
        : `results\u0000${deps.results.key}`;
    const existing = MongoDocumentsPanel.open.get(id);
    if (existing !== undefined && !existing.disposed) {
      if (deps.results !== undefined) {
        void existing.model.close?.();
        existing.model = deps.model;
        existing.panel.title = deps.results.title;
        existing.push(deps.model.state());
        existing.panel.reveal(undefined, true);
      } else {
        existing.panel.reveal();
      }
      return existing;
    }
    const panel = new MongoDocumentsPanel(deps);
    MongoDocumentsPanel.open.set(id, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...MongoDocumentsPanel.open.values()]) {
      panel.dispose();
    }
    MongoDocumentsPanel.open.clear();
  }

  /** Closes the pages of a connection's collection that is gone (dropped or renamed). */
  static closeCollection(connectionId: string, database: string, collection?: string): void {
    for (const [id, panel] of [...MongoDocumentsPanel.open]) {
      const [owner, db, name] = id.split('\u0000');
      if (
        owner === connectionId &&
        db === database &&
        (collection === undefined || name === collection)
      ) {
        panel.dispose();
      }
    }
  }

  private static idOf(connectionId: string, database: string, collection: string): string {
    return `${connectionId}\u0000${database}\u0000${collection}`;
  }

  private constructor(private readonly deps: MongoDocumentsPanelDeps) {
    this.log = deps.logger.child('mongo-documents');
    this.model = deps.model;
    const title =
      deps.results?.title ??
      (deps.collection.length > 60 ? `${deps.collection.slice(0, 57)}…` : deps.collection);
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: MongoDocumentsPanel.viewType,
      title,
      app: 'mongo-documents',
      ...(deps.results === undefined
        ? {}
        : { column: vscode.ViewColumn.Beside, preserveFocus: true }),
    });
    if (deps.results !== undefined) {
      // The result is there already; the page gets it when it says it is ready.
      this.state = deps.model.state();
    }
    this.rpc = new RpcPeer({
      local: mongoDocumentsProtocol.host,
      remote: mongoDocumentsProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('run', async (query) => {
      this.push(await this.model.run(query));
      return {};
    });
    this.rpc.handle('page', async ({ skip }) => {
      this.push(await this.model.page(skip));
      return {};
    });
    this.rpc.handle('refresh', async () => {
      this.push(await this.model.refresh());
      return {};
    });
    this.rpc.handle('count', async () => {
      this.push(await this.model.count());
      return {};
    });
    this.rpc.handle('edit', async ({ row }) => await this.model.edit(row));
    this.rpc.handle('save', async ({ token, text }) => {
      if (!(await this.allowed(vscode.l10n.t('Save the document in "{0}"', deps.collection)))) {
        return {};
      }
      const result = await this.model.save(token, text);
      this.push(this.model.state());
      return result;
    });
    this.rpc.handle('insert', async ({ text }) => {
      if (!(await this.allowed(vscode.l10n.t('Add a document to "{0}"', deps.collection)))) {
        return {};
      }
      const result = await this.model.insert(text);
      this.push(this.model.state());
      return result;
    });
    this.rpc.handle('delete', async ({ rows }) => ({ deleted: await this.delete(rows) }));
    this.rpc.handle('copy', async ({ rows }) => {
      await vscode.env.clipboard.writeText(this.model.copyText(rows));
      return {};
    });
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      if (this.state === undefined) {
        void this.firstRead();
      } else {
        this.rpc.emit('state', this.state);
      }
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
    void this.model.close?.();
    for (const [id, panel] of MongoDocumentsPanel.open) {
      if (panel === this) {
        MongoDocumentsPanel.open.delete(id);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async firstRead(): Promise<void> {
    try {
      this.push(await this.model.refresh());
    } catch (error) {
      this.log.warn('Reading the documents failed', error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private push(state: MongoDocumentsState): void {
    this.state = state;
    if (!this.disposed) {
      this.rpc.emit('state', state);
    }
  }

  /** Production asks every time; read-only is refused by the model with its reason. */
  private async allowed(what: string): Promise<boolean> {
    if (changeVerdict(this.deps.policy) !== 'confirm') {
      return true;
    }
    const go = vscode.l10n.t('Change');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} on the production connection "{1}"?', what, this.deps.policy.name),
      { modal: true },
      go,
    );
    return answer === go;
  }

  private async delete(rows: readonly number[]): Promise<number> {
    const ids = this.model.describe(rows);
    if (ids.length === 0) {
      return 0;
    }
    if (!this.deps.policy.readOnly) {
      const remove = vscode.l10n.t('Delete');
      const shown = ids.slice(0, 10).join('\n') + (ids.length > 10 ? '\n…' : '');
      const answer = await vscode.window.showWarningMessage(
        ids.length === 1
          ? vscode.l10n.t('Delete the document {0}?', ids[0] ?? '')
          : vscode.l10n.t('Delete {0} documents?', ids.length),
        {
          modal: true,
          detail: [
            ...(ids.length === 1 ? [] : [shown]),
            ...(this.deps.policy.production
              ? [vscode.l10n.t('"{0}" is a production connection.', this.deps.policy.name)]
              : []),
          ].join('\n\n'),
        },
        remove,
      );
      if (answer !== remove) {
        return 0;
      }
    }
    // A read-only connection is refused by the model, with the reason.
    const deleted = await this.model.delete(rows);
    this.push(this.deps.model.state());
    return deleted;
  }
}

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { ConnectionManager } from '../../services/connection-manager';
import { endTransaction } from '../../services/transactions';
import type { ConnectionStore } from '../../services/connection-store';
import { type BindingMemory, isKeptDocument, SaveAsMatcher } from '../../services/binding-memory';
import { COMMAND_IDS } from '../command-ids';
import { pickConnection, pickDatabase } from '../connection-pick';
import { DocumentBindings, type DocumentBinding } from './document-bindings';
import { statusView, type StatusTexts } from './status-text';

/** The language id a query document uses, so VS Code highlights it as SQL. */
export const SQL_LANGUAGE_ID = 'sql';

function texts(): StatusTexts {
  return {
    pick: vscode.l10n.t('$(database) Select connection'),
    tooltip: vscode.l10n.t('DataNest: choose the connection and database for this query'),
    connecting: vscode.l10n.t('connecting…'),
    failed: vscode.l10n.t('failed'),
    notConnected: vscode.l10n.t('not connected'),
    production: vscode.l10n.t('$(warning) PROD'),
    readOnly: vscode.l10n.t('$(lock)'),
  };
}

export interface QueryEditorDeps {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  /** Where saved files keep their binding across restarts (V10.2.2). */
  readonly memory?: BindingMemory;
}

/**
 * Query documents: creating them, remembering what each one talks to, and showing
 * that in the status bar. One session per document, released when it closes.
 */
export class QueryEditors implements vscode.Disposable {
  readonly bindings = new DocumentBindings();

  private readonly savedAs = new SaveAsMatcher();

  private readonly deps: QueryEditorDeps;
  private readonly status: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly logger: Logger;

  constructor(deps: QueryEditorDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('editor');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = COMMAND_IDS.selectConnection;
    this.subscriptions.push(
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateStatus();
      }),
      this.bindings.onDidChange(() => {
        this.updateStatus();
      }),
      deps.manager.onDidChangeState(() => {
        this.updateStatus();
      }),
      deps.store.onDidChange(() => {
        this.updateStatus();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        void this.forget(document);
      }),
    );
    const { memory } = deps;
    if (memory !== undefined) {
      this.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
          this.restore(document, memory);
        }),
        this.bindings.onDidChange((documentUri) => {
          const binding = this.bindings.get(documentUri);
          if (binding !== undefined) {
            void this.keep(memory.remember(documentUri, binding));
          }
        }),
        vscode.workspace.onDidRenameFiles((event) => {
          for (const { oldUri, newUri } of event.files) {
            void this.keep(memory.rename(oldUri.toString(), newUri.toString()));
          }
        }),
        // Project connections arrive after activation, and once a workspace is trusted.
        deps.store.onDidChange(() => {
          this.restoreOpen(memory);
        }),
      );
      this.restoreOpen(memory);
    }
    this.updateStatus();
  }

  /** Opens a new SQL document bound to the given connection, if any. */
  async newQuery(binding?: DocumentBinding, content = ''): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument({
      language: SQL_LANGUAGE_ID,
      content,
    });
    if (binding !== undefined) {
      this.bindings.bind(document.uri.toString(), binding);
    }
    await vscode.window.showTextDocument(document, { preview: false });
    this.updateStatus();
    return document;
  }

  /** The binding of the SQL document in front of the user. */
  activeBinding(): DocumentBinding | undefined {
    const uri = activeSqlDocumentUri();
    return uri === undefined ? undefined : this.bindings.get(uri);
  }

  /**
   * Asks for a connection, then for a database when the driver has them, and
   * pins the active document to it.
   */
  async selectConnection(): Promise<DocumentBinding | undefined> {
    const uri = activeSqlDocumentUri();
    if (uri === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
      );
      return undefined;
    }
    const connectionId = await pickConnection(this.deps.store);
    if (connectionId === undefined) {
      return undefined;
    }
    const database = await pickDatabase(this.deps.manager, connectionId);
    const binding: DocumentBinding =
      database === undefined ? { connectionId } : { connectionId, database };
    const current = this.bindings.get(uri);
    const moving =
      current?.connectionId !== binding.connectionId || current.database !== binding.database;
    if (moving && !(await this.settleTransaction(uri))) {
      return undefined;
    }
    this.bindings.bind(uri, binding);
    return binding;
  }

  /**
   * A switch closes the editor's session; an open transaction would silently roll
   * back, so the user decides first (V4.8). False means "stay where you are".
   */
  private async settleTransaction(documentUri: string): Promise<boolean> {
    const owner = ConnectionManager.editorOwner(documentUri);
    const state = this.deps.manager.transactionState(owner);
    if (state !== 'open' && state !== 'failed') {
      return true;
    }
    const commit = vscode.l10n.t('Commit');
    const rollback = vscode.l10n.t('Roll Back');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('This editor has an open transaction. Commit it before switching?'),
      { modal: true },
      ...(state === 'open' ? [commit, rollback] : [rollback]),
    );
    if (choice === undefined) {
      return false;
    }
    await endTransaction(this.deps.manager, owner, choice === commit ? 'commit' : 'rollback');
    return true;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  /** Binds a SQL file to what it was bound to before, or to the query it was saved from. */
  private restore(document: vscode.TextDocument, memory: BindingMemory): void {
    const uri = document.uri.toString();
    if (
      document.languageId !== SQL_LANGUAGE_ID ||
      !isKeptDocument(uri) ||
      this.bindings.get(uri) !== undefined
    ) {
      return;
    }
    // A query saved over an old file brings its own connection with it.
    const target = this.savedAs.fileOpened(uri, document.getText()) ?? memory.get(uri);
    if (target !== undefined && this.deps.store.get(target.connectionId) !== undefined) {
      this.bindings.bind(uri, target);
    }
  }

  private restoreOpen(memory: BindingMemory): void {
    for (const document of vscode.workspace.textDocuments) {
      this.restore(document, memory);
    }
  }

  private async keep(saving: Promise<void>): Promise<void> {
    try {
      await saving;
    } catch (error) {
      this.logger.warn('Could not remember the connection of a SQL file', error);
    }
  }

  private async forget(document: vscode.TextDocument): Promise<void> {
    const uri = document.uri.toString();
    const binding = this.bindings.get(uri);
    if (binding === undefined) {
      return;
    }
    if (this.deps.memory !== undefined && !isKeptDocument(uri)) {
      const file = this.savedAs.untitledClosed(document.getText(), binding);
      const saved = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === file,
      );
      if (file !== undefined && saved !== undefined && this.bindings.get(file) === undefined) {
        this.bindings.bind(file, binding);
      }
    }
    this.bindings.unbind(uri);
    try {
      await this.deps.manager.release(ConnectionManager.editorOwner(uri));
    } catch (error) {
      this.logger.warn('Could not release the session of a closed query', error);
    }
  }

  private updateStatus(): void {
    const uri = activeSqlDocumentUri();
    if (uri === undefined) {
      this.status.hide();
      return;
    }
    const binding = this.bindings.get(uri);
    const config = binding === undefined ? undefined : this.deps.store.get(binding.connectionId);
    const state =
      binding === undefined
        ? { status: 'disconnected' as const }
        : this.deps.manager.getState(binding.connectionId);
    const view = statusView(binding, config, state, texts());
    this.status.text = view.text;
    this.status.tooltip = view.tooltip;
    // Production stands out in red, louder than a connection in trouble.
    this.status.backgroundColor =
      view.production === true
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : view.warning
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.status.show();
  }
}

/** The active editor's document, but only when it is SQL. */
function activeSqlDocumentUri(): string | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (document?.languageId !== SQL_LANGUAGE_ID) {
    return undefined;
  }
  return document.uri.toString();
}

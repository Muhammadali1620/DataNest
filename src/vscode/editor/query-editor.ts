import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import { COMMAND_IDS } from '../command-ids';
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
  };
}

export interface QueryEditorDeps {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
}

/**
 * Query documents: creating them, remembering what each one talks to, and showing
 * that in the status bar. One session per document, released when it closes.
 */
export class QueryEditors implements vscode.Disposable {
  readonly bindings = new DocumentBindings();

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
    this.updateStatus();
  }

  /** Opens a new SQL document bound to the given connection, if any. */
  async newQuery(binding?: DocumentBinding): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument({
      language: SQL_LANGUAGE_ID,
      content: '',
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
    const connectionId = await this.pickConnection();
    if (connectionId === undefined) {
      return undefined;
    }
    const database = await this.pickDatabase(connectionId);
    const binding: DocumentBinding =
      database === undefined ? { connectionId } : { connectionId, database };
    this.bindings.bind(uri, binding);
    return binding;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  private async pickConnection(): Promise<string | undefined> {
    const items = this.deps.store.list().map((config) => ({
      label: config.name,
      description: describeTarget(config),
      id: config.id,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('There are no saved connections yet'),
      );
      return undefined;
    }
    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Pick a connection'),
    });
    return chosen?.id;
  }

  /** `undefined` means "whatever the connection itself opens". */
  private async pickDatabase(connectionId: string): Promise<string | undefined> {
    const driver = await this.deps.manager.driverOf(connectionId);
    if (!driver.capabilities.databases) {
      return undefined;
    }
    const session = await this.deps.manager.connect(connectionId);
    const databases = await session.metadata.listDatabases();
    if (databases.length === 0) {
      return undefined;
    }
    const chosen = await vscode.window.showQuickPick(databases, {
      placeHolder: vscode.l10n.t('Pick a database'),
    });
    return chosen;
  }

  private async forget(document: vscode.TextDocument): Promise<void> {
    const uri = document.uri.toString();
    if (this.bindings.get(uri) === undefined) {
      return;
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
    this.status.backgroundColor = view.warning
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

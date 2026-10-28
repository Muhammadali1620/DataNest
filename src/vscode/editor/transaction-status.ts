import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { ConnectionManager, type TransactionChange } from '../../services/connection-manager';
import type { QueryRunner } from '../../services/query-runner';
import { endTransaction, type TransactionEnd } from '../../services/transactions';
import { COMMAND_IDS } from '../command-ids';
import type { QueryEditors } from './query-editor';
import { SQL_LANGUAGE_ID } from './query-editor';
import type { TransactionModes } from './transaction-modes';
import { transactionView, type TransactionTexts } from './transaction-view';

function texts(): TransactionTexts {
  return {
    auto: vscode.l10n.t('$(sync) Auto-commit'),
    manual: vscode.l10n.t('$(git-commit) Manual commit'),
    open: vscode.l10n.t('$(circle-filled) Transaction open'),
    failed: vscode.l10n.t('$(error) Transaction failed'),
    autoTooltip: vscode.l10n.t(
      'Each statement is saved at once. Click to switch to manual commit: changes then wait for Commit or Rollback.',
    ),
    manualTooltip: vscode.l10n.t(
      'The first change opens a transaction that waits for Commit or Rollback. Click to switch to auto-commit.',
    ),
    openTooltip: vscode.l10n.t(
      'Changes of this editor are not saved yet: Commit keeps them, Rollback undoes them. Others do not see them until then.',
    ),
    failedTooltip: vscode.l10n.t(
      'A statement failed inside the transaction, so the server refuses everything until it is rolled back.',
    ),
  };
}

export interface TransactionStatusDeps {
  readonly editors: QueryEditors;
  readonly manager: ConnectionManager;
  readonly runner: QueryRunner;
  readonly modes: TransactionModes;
  readonly logger: Logger;
}

/**
 * The transaction of the SQL editor in front of the user (V4.8): its mode, whether
 * changes wait for a decision, and the Commit and Rollback buttons. Also tells the
 * user when a transaction ended without them — the editor closed or the link dropped.
 */
export class TransactionStatus implements vscode.Disposable {
  private readonly state: vscode.StatusBarItem;
  private readonly commit: vscode.StatusBarItem;
  private readonly rollback: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: TransactionStatusDeps) {
    // Just right of the connection item (priority 100), in reading order.
    this.state = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.state.command = COMMAND_IDS.toggleTransactionMode;
    this.commit = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.commit.command = COMMAND_IDS.commitTransaction;
    this.commit.text = vscode.l10n.t('$(check) Commit');
    this.commit.tooltip = vscode.l10n.t('Save the changes of the open transaction');
    this.rollback = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    this.rollback.command = COMMAND_IDS.rollbackTransaction;
    this.rollback.text = vscode.l10n.t('$(discard) Rollback');
    this.rollback.tooltip = vscode.l10n.t('Undo every change of the open transaction');
    this.subscriptions.push(
      this.state,
      this.commit,
      this.rollback,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.update();
      }),
      deps.editors.bindings.onDidChange(() => {
        this.update();
      }),
      deps.modes.onDidChange(() => {
        this.update();
      }),
      deps.manager.onDidChangeState(() => {
        this.update();
      }),
      deps.manager.onDidChangeTransaction((change) => {
        this.update();
        this.warnIfEnded(change);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        deps.modes.forget(document.uri.toString());
      }),
    );
    this.update();
  }

  /** Commits or rolls back the transaction of the active SQL editor. */
  async end(end: TransactionEnd): Promise<void> {
    const documentUri = activeSqlDocumentUri();
    if (documentUri === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
      );
      return;
    }
    if (this.deps.runner.isRunning(documentUri)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('A query is running in this editor; wait for it to finish'),
      );
      return;
    }
    await endTransaction(this.deps.manager, ConnectionManager.editorOwner(documentUri), end);
    this.deps.logger.info(`${end === 'commit' ? 'Committed' : 'Rolled back'} in ${documentUri}`);
    void vscode.window.setStatusBarMessage(
      end === 'commit'
        ? vscode.l10n.t('DataNest: transaction committed')
        : vscode.l10n.t('DataNest: transaction rolled back'),
      4000,
    );
  }

  /** Switches the active editor between auto-commit and manual commit. */
  toggleMode(): void {
    const documentUri = activeSqlDocumentUri();
    if (documentUri === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
      );
      return;
    }
    const mode = this.deps.modes.toggle(documentUri);
    void vscode.window.setStatusBarMessage(
      mode === 'manual'
        ? vscode.l10n.t('DataNest: manual commit — changes wait for Commit or Rollback')
        : vscode.l10n.t('DataNest: auto-commit — each statement is saved at once'),
      4000,
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  private update(): void {
    const documentUri = activeSqlDocumentUri();
    const binding =
      documentUri === undefined ? undefined : this.deps.editors.bindings.get(documentUri);
    if (documentUri === undefined || binding === undefined) {
      this.hideAll();
      return;
    }
    const owner = ConnectionManager.editorOwner(documentUri);
    const state = this.deps.manager.transactionState(owner);
    if (this.deps.manager.sessionOf(owner) !== undefined && state === undefined) {
      // This database cannot report transactions, so there is nothing to show.
      this.hideAll();
      return;
    }
    const view = transactionView(this.deps.modes.modeOf(documentUri), state, texts());
    this.state.text = view.text;
    this.state.tooltip = view.tooltip;
    this.state.backgroundColor =
      view.tone === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : view.tone === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.state.show();
    if (view.commit) {
      this.commit.show();
    } else {
      this.commit.hide();
    }
    if (view.rollback) {
      this.rollback.show();
    } else {
      this.rollback.hide();
    }
  }

  private hideAll(): void {
    this.state.hide();
    this.commit.hide();
    this.rollback.hide();
  }

  private warnIfEnded(change: TransactionChange): void {
    const prefix = ConnectionManager.editorOwner('');
    if (change.ended === undefined || !change.owner.startsWith(prefix)) {
      return;
    }
    const name = documentName(change.owner.slice(prefix.length));
    void vscode.window.showWarningMessage(
      change.ended === 'lost'
        ? vscode.l10n.t(
            'The connection of {0} was lost, and the server rolled its open transaction back.',
            name,
          )
        : vscode.l10n.t(
            'The open transaction of {0} was rolled back: its session was closed.',
            name,
          ),
    );
  }
}

/** The active editor's document, but only when it is SQL. */
function activeSqlDocumentUri(): string | undefined {
  const document = vscode.window.activeTextEditor?.document;
  return document?.languageId === SQL_LANGUAGE_ID ? document.uri.toString() : undefined;
}

function documentName(documentUri: string): string {
  const path = vscode.Uri.parse(documentUri).path;
  return path.slice(path.lastIndexOf('/') + 1) || documentUri;
}

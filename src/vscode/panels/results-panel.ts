import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { QueryRunner } from '../../services/query-runner';
import type { ExportFormat } from '../../services/result-export';
import type { ResultEditor } from '../../services/result-editor';
import type { ResultSaver } from '../../services/result-saver';
import type { ResultStore } from '../../services/result-store';
import {
  MAX_SEARCH_HITS,
  resultGridProtocol,
  type ResultGridProtocol,
} from '../../shared/protocols/result-grid';
import { RpcPeer } from '../../shared/rpc';
import { buildState, errorOffsetOf } from './results-state';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ResultsPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly results: ResultStore;
  readonly runner: QueryRunner;
  readonly editor: ResultEditor;
  readonly saver: ResultSaver;
  /** Shows another page of a table view; absent where paging makes no sense. */
  readonly pageTo?: (resultId: string, offset: number) => Promise<boolean>;
  /** Writes a result to a file the user picks. */
  readonly exportResult?: (resultId: string, format: ExportFormat) => Promise<void>;
  readonly logger: Logger;
}

/**
 * One panel per SQL document, beside the editor. It is created on the first run
 * and reused afterwards; closing it is harmless, the next run opens it again.
 */
export class ResultsPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.results';

  private static readonly open = new Map<string, ResultsPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly deps: ResultsPanelDeps;
  private readonly rpc: RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly documentUri: string;
  private activeId: string | undefined;
  private disposed = false;

  /** Shows the results of a document, creating the panel when needed. */
  static show(deps: ResultsPanelDeps, documentUri: string): ResultsPanel {
    const existing = ResultsPanel.open.get(documentUri);
    if (existing && !existing.disposed) {
      existing.reveal();
      existing.update();
      return existing;
    }
    const panel = new ResultsPanel(deps, documentUri);
    ResultsPanel.open.set(documentUri, panel);
    return panel;
  }

  /** The panel of a document, if it is open. */
  static find(documentUri: string): ResultsPanel | undefined {
    const panel = ResultsPanel.open.get(documentUri);
    return panel?.disposed === false ? panel : undefined;
  }

  static disposeAll(): void {
    for (const panel of [...ResultsPanel.open.values()]) {
      panel.dispose();
    }
    ResultsPanel.open.clear();
  }

  private constructor(deps: ResultsPanelDeps, documentUri: string) {
    this.deps = deps;
    this.documentUri = documentUri;
    const log = deps.logger.child('results');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ResultsPanel.viewType,
      title: vscode.l10n.t('Results'),
      app: 'result-grid',
      column: vscode.ViewColumn.Beside,
      // Results appear next to the query; the cursor stays in the editor.
      preserveFocus: true,
    });
    this.rpc = new RpcPeer({
      local: resultGridProtocol.host,
      remote: resultGridProtocol.webview,
      transport: webviewTransport(this.panel.webview, log),
      onProtocolError: (problem) => {
        log.warn(problem);
      },
    });
    this.rpc.handle('rows', ({ resultId, offset, limit }) => {
      const window = this.deps.results.window(resultId, offset, limit);
      if (window === undefined) {
        // The result is gone (a newer run replaced it); an empty window is honest.
        return { resultId, offset, rows: [], rowCount: 0, changes: [], states: [] };
      }
      return {
        resultId,
        offset: window.offset,
        rows: window.rows.map((row) => [...row]),
        rowCount: window.rowCount,
        changes: window.changes,
        states: window.states,
      };
    });
    this.rpc.handle('saveChanges', async ({ resultId }) => {
      const outcome = await this.deps.saver.save(resultId);
      if (outcome.ok) {
        if (!outcome.refreshed) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Changes were saved, but the rows could not be read again. Run the query again.',
            ),
          );
        }
        return { ok: true, statements: outcome.statements, refreshed: outcome.refreshed };
      }
      return {
        ok: false,
        message: outcome.message,
        ...(outcome.statement === undefined ? {} : { statement: outcome.statement }),
      };
    });
    this.rpc.handle('previewChanges', async ({ resultId }) => {
      const outcome = await this.deps.saver.preview(resultId);
      if (!outcome.ok) {
        return { ok: false, message: outcome.message };
      }
      const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: outcome.sql,
      });
      await vscode.window.showTextDocument(document, { preview: true });
      return { ok: true };
    });
    this.rpc.handle('discardChanges', async ({ resultId }) => {
      const summary = this.deps.results.get(resultId);
      const count =
        (summary?.changedCells ?? 0) + (summary?.insertedRows ?? 0) + (summary?.deletedRows ?? 0);
      // A webview cannot ask for confirmation itself, and this cannot be undone.
      const discard = vscode.l10n.t('Discard');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Discard {0} unsaved changes?', count),
        { modal: true },
        discard,
      );
      return { ok: choice === discard && this.deps.results.discardPending(resultId) };
    });
    this.rpc.handle('rowAction', ({ resultId, action, rows }) =>
      this.deps.editor.rowAction(resultId, action, rows),
    );
    this.rpc.handle('editCell', ({ resultId, row, column, input }) =>
      this.deps.editor.editCell(resultId, row, column, input),
    );
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.handle('sort', ({ resultId, column, direction }) => {
      const sorted = this.deps.results.sort(resultId, column, direction);
      return { resultId, applied: sorted !== undefined };
    });
    this.rpc.handle('pageTo', async ({ resultId, offset }) => {
      const applied = (await this.deps.pageTo?.(resultId, offset)) ?? false;
      return { resultId, applied };
    });
    this.rpc.handle('search', ({ resultId, text }) => {
      const hits = this.deps.results.search(resultId, text, MAX_SEARCH_HITS);
      return { resultId, rows: hits?.rows ?? [], total: hits?.total ?? 0 };
    });
    this.rpc.on('ready', () => {
      this.update();
    });
    this.rpc.on('selectTab', ({ resultId }) => {
      this.activeId = resultId;
    });
    this.rpc.on('cancel', () => {
      void this.deps.runner.cancel(this.documentUri);
    });
    this.rpc.on('copyText', ({ text }) => {
      void vscode.env.clipboard.writeText(text);
    });
    this.rpc.on('revealError', ({ resultId }) => {
      void this.revealError(resultId);
    });
    this.rpc.on('exportResult', ({ resultId, format }) => {
      void this.deps.exportResult?.(resultId, format);
    });
    this.subscriptions.push(
      deps.results.onDidChange((documentUri) => {
        if (documentUri === this.documentUri) {
          this.update();
        }
      }),
      deps.runner.onDidChangeRunning((documentUri) => {
        if (documentUri === this.documentUri) {
          this.update();
        }
      }),
    );
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** The result the user is looking at, for commands outside the page. */
  get activeResultId(): string | undefined {
    return this.activeId;
  }

  /** Brings the panel forward without stealing focus from the editor. */
  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  update(): void {
    if (this.disposed) {
      return;
    }
    const summaries = this.deps.results.forDocument(this.documentUri);
    const state = buildState(
      summaries,
      this.activeId,
      this.deps.runner.isRunning(this.documentUri),
    );
    this.activeId = state.activeId;
    this.rpc.emit('state', state);
  }

  /** Opens the query and puts the cursor on the character the server complained about. */
  private async revealError(resultId: string): Promise<void> {
    const summary = this.deps.results.get(resultId);
    if (summary?.error === undefined) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.documentUri));
    const offset = errorOffsetOf(summary, document.getText().length);
    if (offset === undefined) {
      return;
    }
    const position = document.positionAt(offset);
    const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    for (const [key, panel] of ResultsPanel.open) {
      if (panel === this) {
        ResultsPanel.open.delete(key);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }
}

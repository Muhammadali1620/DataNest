import * as vscode from 'vscode';
import { changeVerdict, NO_POLICY, type WritePolicy } from '../../services/write-policy';
import type { Logger } from '../../core/logging/logger';
import type { QueryRunner } from '../../services/query-runner';
import type { ExportFormat } from '../../services/result-export';
import type { ResultEditor } from '../../services/result-editor';
import type { TableRef } from '../../core/model/objects';
import type { SessionTarget } from '../../services/connection-manager';
import type { ResultLinks } from '../../services/result-links';
import type { TableFilter } from '../../shared/table-filter';
import type { ResultCopier } from '../../services/result-copier';
import type { ResultSaver } from '../../services/result-saver';
import type { TableChange } from '../../services/table-view';
import type { ResultStore } from '../../services/result-store';
import { retainedBytes } from '../../shared/binary-bytes';
import { homedir } from 'node:os';
import { errorMessage } from '../../core/errors';
import {
  cellFileBytes,
  cellFileExtension,
  fileNameFor,
  MAX_CELL_FILE_BYTES,
} from '../../services/cell-file';
import {
  LOAD_ALL_WARNING_ROWS,
  MAX_PAGE_SIZE,
  MAX_SEARCH_HITS,
  resultGridProtocol,
  type ResultGridProtocol,
} from '../../shared/protocols/result-grid';
import { RpcPeer } from '../../shared/rpc';
import { replacementFor, revealColumn, type SqlTextOutcome } from '../../services/sql-text-outcome';
import { buildState, errorOffsetOf, followActive } from './results-state';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';
import { formatCount } from '../../core/number-format';

export interface ResultsPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly results: ResultStore;
  readonly runner: QueryRunner;
  readonly editor: ResultEditor;
  readonly saver: ResultSaver;
  /** Re-reads a table view with another page, filter or order; absent outside table views. */
  readonly reloadTable?: (resultId: string, change: TableChange) => Promise<boolean>;
  /** Finds the row a foreign key cell points at. */
  readonly links: ResultLinks;
  /** Opens a table filtered to the related row, in that table's own panel. */
  readonly openRelated: (
    target: SessionTarget,
    table: TableRef,
    filter: TableFilter,
  ) => Promise<void>;
  /** Renders cells in a format; the panel puts the text on the clipboard. */
  readonly copier: ResultCopier;
  /** Writes a result to a file the user picks. */
  readonly exportResult?: (
    resultId: string,
    format: ExportFormat,
    scope?: 'result' | 'table' | 'database',
  ) => Promise<void>;
  /** Opens the import page for a table (V12.1); absent until the commands exist. */
  readonly importInto?: (connectionId: string, table: TableRef) => Promise<void>;
  /** Runs SQL typed on the page in the document the result belongs to (V12.1). */
  readonly runSql?: (request: {
    documentUri: string;
    target: SessionTarget;
    sql: string;
    replace?: { resultId: string } | { all: true };
  }) => Promise<SqlTextOutcome>;
  /** The connection a document runs on: its table view's, or its editor's binding. */
  readonly targetOf?: (documentUri: string) => SessionTarget | undefined;
  /** The table a document's table view shows, if it is one. */
  readonly tableOf?: (
    documentUri: string,
  ) => { target: SessionTarget; table: TableRef } | undefined;
  /** Opens a chart of a result (V8.7). */
  readonly chartResult?: (resultId: string) => void;
  /** Production and read-only flags of a connection, checked before saving edits. */
  readonly policy?: (connectionId: string) => WritePolicy;
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
    this.rpc.handle('binaryBytes', ({ resultId, row, column }) => {
      const cell = this.deps.results.window(resultId, row, 1)?.rows[0]?.[column];
      if (typeof cell !== 'object' || cell?.kind !== 'binary') {
        return { size: 0 };
      }
      const bytes = retainedBytes(cell);
      return bytes === undefined
        ? { size: cell.size }
        : { size: cell.size, data: Buffer.from(bytes).toString('base64') };
    });
    this.rpc.handle('saveValue', async ({ resultId, row, column }) => {
      const cell = this.deps.results.window(resultId, row, 1)?.rows[0]?.[column];
      const bytes = cellFileBytes(cell);
      if (typeof bytes === 'string') {
        return { ok: false, error: bytes };
      }
      const name = this.deps.results.get(resultId)?.columns[column]?.name ?? 'value';
      const target = await vscode.window.showSaveDialog({
        title: vscode.l10n.t('Save the Value to a File'),
        defaultUri: vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()),
          `${fileNameFor(name)}.${cellFileExtension(cell)}`,
        ),
      });
      if (target === undefined) {
        return { ok: false, error: 'cancelled' };
      }
      try {
        await vscode.workspace.fs.writeFile(target, bytes);
        return { ok: true };
      } catch (error) {
        this.deps.logger.warn('Could not save a value to a file', error);
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Could not save the file: {0}', errorMessage(error)),
        );
        return { ok: false, error: 'failed' };
      }
    });
    this.rpc.handle('loadValue', async ({ resultId, row, column }) => {
      const [source] =
        (await vscode.window.showOpenDialog({
          title: vscode.l10n.t('Load a File into the Cell'),
          canSelectMany: false,
        })) ?? [];
      if (source === undefined) {
        return { ok: false, cancelled: true };
      }
      const { size } = await vscode.workspace.fs.stat(source);
      if (size > MAX_CELL_FILE_BYTES) {
        return { ok: false, error: 'too-large' };
      }
      const bytes = await vscode.workspace.fs.readFile(source);
      return this.deps.editor.setFromFile(resultId, row, column, bytes);
    });
    this.rpc.handle('saveChanges', async ({ resultId }) => {
      const refusal = await this.guardSave(resultId);
      if (refusal !== undefined) {
        return { ok: false, message: refusal };
      }
      const outcome = await this.deps.saver.save(resultId);
      if (outcome.ok) {
        if (!outcome.refreshed) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Changes were saved, but the rows could not be read again. Run the query again.',
            ),
          );
        }
        if (outcome.inTransaction) {
          // The rows are written, but only the user's Commit makes them stay (V4.8).
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              'The changes joined the open transaction of the editor: Commit keeps them, Rollback undoes them.',
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
    this.rpc.handle('sort', async ({ resultId, column, direction }) => {
      const summary = this.deps.results.get(resultId);
      const name = summary?.columns[column]?.name;
      if (summary?.page !== undefined && name !== undefined) {
        // A table view is paged, so the server must order the whole table, not one page.
        const applied =
          (await this.deps.reloadTable?.(resultId, {
            sort: direction === undefined ? null : { column: name, direction },
          })) ?? false;
        return { resultId, applied };
      }
      const sorted = await this.deps.results.sort(resultId, column, direction);
      return { resultId, applied: sorted !== undefined };
    });
    this.rpc.handle('runSql', async ({ resultId, sql }) => {
      const summary = this.deps.results.get(resultId);
      const target = summary?.origin?.target ?? this.deps.targetOf?.(this.documentUri);
      if (summary === undefined || target === undefined || this.deps.runSql === undefined) {
        return { ok: false, error: vscode.l10n.t('This result is no longer available') };
      }
      // The statement was edited on this tab, so its results take this tab's place; a table
      // view has a single result, whatever it becomes.
      const replace = replacementFor(this.deps.tableOf?.(this.documentUri) !== undefined, resultId);
      return await this.deps.runSql({ documentUri: this.documentUri, target, sql, replace });
    });
    this.rpc.handle('pageTo', async ({ resultId, offset }) => {
      const applied = (await this.deps.reloadTable?.(resultId, { offset })) ?? false;
      return { resultId, applied };
    });
    this.rpc.handle('followLink', async (params) => {
      const outcome = this.deps.links.follow(params);
      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      await this.deps.openRelated(outcome.target, outcome.table, outcome.filter);
      return { ok: true };
    });
    this.rpc.handle('copyAs', async (params) => {
      const outcome = await this.deps.copier.render(params);
      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      await vscode.env.clipboard.writeText(outcome.text);
      return { ok: true, rows: outcome.rows };
    });
    this.rpc.handle('summarize', async ({ resultId, top, bottom, columns }) => {
      const summary = await this.deps.results.summarize(resultId, top, bottom, columns);
      return summary === undefined ? { stale: true } : { ...summary };
    });
    this.rpc.handle('pageSize', async ({ resultId, pageSize }) => {
      const applied = (await this.deps.reloadTable?.(resultId, { pageSize })) ?? false;
      return { resultId, applied };
    });
    this.rpc.handle('countRows', async ({ resultId }) => {
      const applied = (await this.deps.reloadTable?.(resultId, { exactCount: true })) ?? false;
      return { resultId, applied };
    });
    this.rpc.handle('loadAll', async ({ resultId }) => {
      const page = this.deps.results.get(resultId)?.page;
      if (page === undefined) {
        return { resultId, applied: false };
      }
      // An estimate may be short, so it cannot size the page; the cap is the limit then.
      const rows =
        page.totalRows === undefined || page.approximate === true
          ? MAX_PAGE_SIZE
          : Math.min(Math.max(page.totalRows, 1), MAX_PAGE_SIZE);
      if (rows > LOAD_ALL_WARNING_ROWS) {
        // The rows all live in memory, so a big table deserves a second thought.
        const load = vscode.l10n.t('Load');
        const choice = await vscode.window.showWarningMessage(
          page.totalRows === undefined || page.approximate === true
            ? vscode.l10n.t(
                'Load the whole table? It may hold a very large number of rows (up to {0}), which can be slow and use a lot of memory.',
                formatCount(MAX_PAGE_SIZE, vscode.env.language),
              )
            : vscode.l10n.t(
                'Load all {0} rows? This can be slow and use a lot of memory.',
                formatCount(rows, vscode.env.language),
              ),
          { modal: true },
          load,
        );
        if (choice !== load) {
          return { resultId, applied: false };
        }
      }
      const applied = (await this.deps.reloadTable?.(resultId, { pageSize: rows })) ?? false;
      return { resultId, applied };
    });
    this.rpc.handle('filterTable', async ({ resultId, filter }) => {
      const applied = (await this.deps.reloadTable?.(resultId, { filter })) ?? false;
      return { resultId, applied };
    });
    this.rpc.handle('search', async ({ resultId, text }) => {
      // Undefined when a newer search overtook this one (or the result is gone): the
      // page keeps what it shows instead of flashing "no matches".
      const hits = await this.deps.results.search(resultId, text, MAX_SEARCH_HITS);
      return hits === undefined
        ? { resultId, rows: [], total: 0, stale: true }
        : { resultId, rows: hits.rows, total: hits.total };
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
    this.rpc.on('exportResult', ({ resultId, format, scope }) => {
      void this.deps.exportResult?.(resultId, format, scope);
    });
    this.rpc.on('importInto', ({ resultId }) => {
      const view =
        this.deps.results.get(resultId) === undefined
          ? undefined
          : this.deps.tableOf?.(this.documentUri);
      if (view === undefined || this.deps.importInto === undefined) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Only a table opened from the tree can be imported into'),
        );
        return;
      }
      void this.deps.importInto(view.target.connectionId, {
        ...view.table,
        ...(view.table.database === undefined && view.target.database !== undefined
          ? { database: view.target.database }
          : {}),
      });
    });
    this.rpc.on('openTools', () => {
      void vscode.commands.executeCommand('datanest.tools.open');
    });
    this.rpc.on('chartResult', ({ resultId }) => {
      this.deps.chartResult?.(resultId);
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
    // Stay where the panel is: "beside" would split again when it sits in the active group.
    this.panel.reveal(revealColumn(this.panel.viewColumn, vscode.ViewColumn.Beside), true);
  }

  update(): void {
    if (this.disposed) {
      return;
    }
    const summaries = this.deps.results.forDocument(this.documentUri);
    // A replaced active tab is followed to its replacement, so the user stays where they were.
    const followed = followActive(summaries, this.activeId, (id) =>
      this.deps.results.successorOf(id),
    );
    const state = buildState(summaries, followed, this.deps.runner.isRunning(this.documentUri));
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

  /**
   * A read-only connection refuses the save; on production the user confirms it.
   * Returns why nothing was saved, or undefined to go ahead.
   */
  private async guardSave(resultId: string): Promise<string | undefined> {
    const summary = this.deps.results.get(resultId);
    const connectionId = summary?.origin?.target.connectionId;
    const policy =
      connectionId === undefined ? NO_POLICY : (this.deps.policy?.(connectionId) ?? NO_POLICY);
    const verdict = changeVerdict(policy);
    if (verdict === 'refuse') {
      return vscode.l10n.t('"{0}" is read-only: changes cannot be saved.', policy.name);
    }
    if (verdict === 'confirm') {
      const count =
        (summary?.changedCells ?? 0) + (summary?.insertedRows ?? 0) + (summary?.deletedRows ?? 0);
      const save = vscode.l10n.t('Save to Production');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Save {0} changes to the production database "{1}"?', count, policy.name),
        { modal: true },
        save,
      );
      if (choice !== save) {
        return vscode.l10n.t('Not saved: the changes are still pending.');
      }
    }
    return undefined;
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

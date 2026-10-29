// The data import page (V5.3): one panel per import. It keeps the state the page
// needs on reload (D21), asks before writing to a production table, and turns the
// run into progress and a report on the page.

import { basename } from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ImportReport } from '../../services/import/table-import';
import type { WritePolicy } from '../../services/write-policy';
import { changeVerdict } from '../../services/write-policy';
import {
  dataImportProtocol,
  type DataImportProtocol,
  type ImportMapping,
  type ImportOptions,
  type ImportPageProgress,
  type ImportPageState,
} from '../../shared/protocols/data-import';
import { RpcPeer } from '../../shared/rpc';
import type { DataImportModel } from './data-import-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface DataImportPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: DataImportModel;
  /** `shop.orders`, for the title and the questions. */
  readonly tableLabel: string;
  readonly file: string;
  readonly size: number;
  readonly policy: WritePolicy;
  /** Called after rows went in: cached structure and open results may be stale. */
  readonly onImported: () => void;
}

/** Progress reaches the page at most this often. */
const PROGRESS_INTERVAL_MS = 200;

export class DataImportPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.dataImport';

  private static readonly open = new Set<DataImportPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<DataImportProtocol['host'], DataImportProtocol['webview']>;
  private readonly log: Logger;
  private state: ImportPageState | undefined;
  private abort: AbortController | undefined;
  private disposed = false;

  static async show(deps: DataImportPanelDeps): Promise<DataImportPanel> {
    const options = await deps.model.guessOptions();
    const { source, mapping } = await deps.model.load(options);
    const panel = new DataImportPanel(deps, {
      driver: deps.model.driver,
      transactional: deps.model.transactional,
      table: deps.tableLabel,
      file: basename(deps.file),
      size: deps.size,
      columns: deps.model.columns,
      options,
      source,
      mapping,
    });
    DataImportPanel.open.add(panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...DataImportPanel.open]) {
      panel.dispose();
    }
  }

  private constructor(
    private readonly deps: DataImportPanelDeps,
    initial: ImportPageState,
  ) {
    this.log = deps.logger.child('import-panel');
    this.state = initial;
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: DataImportPanel.viewType,
      title: vscode.l10n.t('Import into {0}', deps.tableLabel),
      app: 'data-import',
    });
    this.rpc = new RpcPeer({
      local: dataImportProtocol.host,
      remote: dataImportProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('load', async (options) => {
      const loaded = await deps.model.load(options);
      this.remember({ options, ...loaded });
      return loaded;
    });
    this.rpc.handle('preview', async ({ options, mapping }) => ({
      rows: await deps.model.preview(options, mapping),
    }));
    this.rpc.handle('start', async ({ options, mapping, mode }) => ({
      started: await this.start(options, mapping, mode),
    }));
    this.rpc.on('ready', () => {
      if (this.state !== undefined) {
        this.rpc.emit('state', this.state);
      }
    });
    this.rpc.on('cancel', () => {
      this.abort?.abort();
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

  private remember(change: Partial<ImportPageState>): void {
    if (this.state !== undefined) {
      this.state = { ...this.state, ...change };
    }
  }

  private async start(
    options: ImportOptions,
    mapping: ImportMapping,
    mode: 'all' | 'skip',
  ): Promise<boolean> {
    if (this.abort !== undefined) {
      return false;
    }
    const verdict = changeVerdict(this.deps.policy);
    if (verdict === 'refuse') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          '"{0}" is read-only: data cannot be imported into it.',
          this.deps.policy.name,
        ),
      );
      return false;
    }
    if (verdict === 'confirm') {
      const go = vscode.l10n.t('Import');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'PRODUCTION "{0}": import "{1}" into {2}?',
          this.deps.policy.name,
          basename(this.deps.file),
          this.deps.tableLabel,
        ),
        { modal: true },
        go,
      );
      if (choice !== go) {
        return false;
      }
    }
    this.remember({ options, mapping, report: undefined });
    void this.runImport(options, mapping, mode);
    return true;
  }

  private async runImport(
    options: ImportOptions,
    mapping: ImportMapping,
    mode: 'all' | 'skip',
  ): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    let shownAt = 0;
    const show = (progress: ImportPageProgress): void => {
      this.remember({ progress });
      if (!this.disposed) {
        this.rpc.emit('progress', progress);
      }
    };
    let report: ImportReport;
    try {
      report = await this.deps.model.run(options, mapping, mode, {
        signal: abort.signal,
        onProgress: (read, inserted, failed, bytes) => {
          const now = Date.now();
          if (now - shownAt < PROGRESS_INTERVAL_MS) {
            return;
          }
          shownAt = now;
          show({ read, inserted, failed, percent: percentOf(bytes, this.deps.size) });
        },
      });
    } catch (error) {
      this.log.error('The import failed', error);
      report = {
        outcome: 'stopped',
        read: 0,
        inserted: 0,
        failedCount: 1,
        failures: [{ line: 0, message: errorMessage(error) }],
        rolledBack: mode === 'all',
        durationMs: 0,
      };
    } finally {
      this.abort = undefined;
    }
    if (report.inserted > 0) {
      this.deps.onImported();
    }
    const view = { ...report, failures: [...report.failures] };
    this.remember({ progress: undefined, report: view });
    if (!this.disposed) {
      this.rpc.emit('finished', view);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Closing the page stops the import; what a skip-mode run already wrote stays.
    this.abort?.abort();
    DataImportPanel.open.delete(this);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

function percentOf(bytes: number, size: number): number {
  return size <= 0 ? 0 : Math.min(100, (bytes / size) * 100);
}

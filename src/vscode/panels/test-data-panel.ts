// The test data page (V5.5): one panel per table. It keeps what the page needs on
// reload (D21), asks before writing to production, and reports the run.

import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { changeVerdict, type WritePolicy } from '../../services/write-policy';
import { RpcPeer } from '../../shared/rpc';
import {
  MAX_SCRIPT_ROWS,
  testDataProtocol,
  type TestDataProtocol,
  type TestDataReport,
  type TestDataState,
} from '../../shared/protocols/test-data';
import type { ColumnChoice } from '../../services/test-data/test-data';
import type { TestDataModel } from './test-data-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface TestDataPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: TestDataModel;
  /** `shop.orders`, for the title and the questions. */
  readonly tableLabel: string;
  readonly policy: WritePolicy;
  /** Opens SQL text in a new editor on the table's connection. */
  readonly openSql: (sql: string) => Promise<void>;
  /** Called after rows went in. */
  readonly onInserted: () => void;
}

const PROGRESS_INTERVAL_MS = 200;

export class TestDataPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.testData';

  private static readonly open = new Set<TestDataPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<TestDataProtocol['host'], TestDataProtocol['webview']>;
  private readonly log: Logger;
  private state: TestDataState;
  private abort: AbortController | undefined;
  private disposed = false;

  static show(deps: TestDataPanelDeps): TestDataPanel {
    const panel = new TestDataPanel(deps);
    TestDataPanel.open.add(panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...TestDataPanel.open]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: TestDataPanelDeps) {
    this.log = deps.logger.child('test-data');
    this.state = deps.model.initialState(deps.tableLabel);
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: TestDataPanel.viewType,
      title: vscode.l10n.t('Test Data for {0}', deps.tableLabel),
      app: 'test-data',
    });
    this.rpc = new RpcPeer({
      local: testDataProtocol.host,
      remote: testDataProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('preview', async ({ choices, seed }) => {
      this.state = { ...this.state, choices, seed };
      return await deps.model.preview(choices, seed);
    });
    this.rpc.handle('insert', async ({ choices, count, seed }) => ({
      started: await this.insert(choices, count, seed),
    }));
    this.rpc.handle('openSql', async ({ choices, count, seed }) => {
      if (count > MAX_SCRIPT_ROWS) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'An editor takes at most {0} generated rows; insert larger amounts directly',
            MAX_SCRIPT_ROWS,
          ),
        );
        return { opened: false };
      }
      await deps.openSql(await deps.model.script(choices, count, seed));
      return { opened: true };
    });
    this.rpc.on('ready', () => {
      this.rpc.emit('state', this.state);
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

  private async insert(choices: ColumnChoice[], count: number, seed: number): Promise<boolean> {
    if (this.abort !== undefined) {
      return false;
    }
    const verdict = changeVerdict(this.deps.policy);
    if (verdict === 'refuse') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('"{0}" is read-only: data cannot be inserted.', this.deps.policy.name),
      );
      return false;
    }
    if (verdict === 'confirm') {
      const go = vscode.l10n.t('Insert');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'PRODUCTION "{0}": insert {1} generated rows into {2}?',
          this.deps.policy.name,
          count,
          this.deps.tableLabel,
        ),
        { modal: true },
        go,
      );
      if (choice !== go) {
        return false;
      }
    }
    this.state = { ...this.state, choices, count, seed, report: undefined };
    void this.run(choices, count, seed);
    return true;
  }

  private async run(choices: ColumnChoice[], count: number, seed: number): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    let shownAt = 0;
    let report: TestDataReport;
    try {
      const result = await this.deps.model.run(choices, count, seed, {
        signal: abort.signal,
        onProgress: (done) => {
          const now = Date.now();
          if (now - shownAt >= PROGRESS_INTERVAL_MS) {
            shownAt = now;
            const progress = { done, total: count };
            this.state = { ...this.state, progress };
            if (!this.disposed) {
              this.rpc.emit('progress', progress);
            }
          }
        },
      });
      const failure = result.failures[0];
      report = {
        outcome: result.outcome,
        inserted: result.inserted,
        ...(failure === undefined
          ? {}
          : {
              message:
                failure.message ??
                vscode.l10n.t('A value for {0} does not fit its type', failure.column ?? ''),
            }),
        durationMs: result.durationMs,
      };
    } catch (error) {
      this.log.error('Generating test data failed', error);
      report = { outcome: 'stopped', inserted: 0, message: errorMessage(error), durationMs: 0 };
    } finally {
      this.abort = undefined;
    }
    if (report.inserted > 0) {
      this.deps.onInserted();
    }
    this.state = { ...this.state, progress: undefined, report };
    if (!this.disposed) {
      this.rpc.emit('finished', report);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abort?.abort();
    TestDataPanel.open.delete(this);
    this.rpc.dispose();
    this.panel.dispose();
  }
}

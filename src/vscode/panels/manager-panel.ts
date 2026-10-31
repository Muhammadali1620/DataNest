// The Manager page (V11.13): one panel per connection. Dashboard and ProcessList read
// the server with a session of the page's own (the server monitor's model), Structure
// Sync drives the schema comparison's model, Log reads the statement history and Dump
// writes a SQL script. Questions to the user (dialogs, confirmations) are asked here.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { isDbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { formatSize } from '../../shared/byte-size';
import { RpcPeer } from '../../shared/rpc';
import { managerProtocol, type ManagerProtocol } from '../../shared/protocols/manager';
import { type DumpSink, expandOutput, type ManagerModel, type ManagerStart } from './manager-model';
import type { ServerMonitorModel } from './server-monitor-model';
import { confirmStop } from './stop-confirm';
import { tableActionCall } from './table-action';
import { navigateTable } from './table-nav';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ManagerPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: ManagerModel;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly production: boolean;
  /** The server monitor's model, made when Dashboard or ProcessList first needs it. */
  readonly monitor: () => ServerMonitorModel;
  /** Closes the page's server session. */
  readonly release: () => Promise<void>;
  /** Tells when the statements of the connection change. */
  readonly onHistoryChange: (listener: () => void) => vscode.Disposable;
  /** Forgets the cached structure of the connection, so Refresh reads it again. */
  readonly invalidate: () => void;
  /** Opens the script of a comparison in an editor on the schema it changes. */
  readonly openScript: (text: string, connectionId: string, database?: string) => Promise<void>;
  /** Where a dump goes when its path has no folder. */
  readonly folder: () => string | undefined;
  readonly start: ManagerStart;
}

const PROGRESS_INTERVAL_MS = 250;
const COMPARE_PROGRESS_INTERVAL_MS = 150;

export class ManagerPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.manager';

  private static readonly open = new Map<string, ManagerPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ManagerProtocol['host'], ManagerProtocol['webview']>;
  private readonly log: Logger;
  private readonly subscriptions: vscode.Disposable[] = [];
  private monitorModel: ServerMonitorModel | undefined;
  private monitorStarting: Promise<void> | undefined;
  private compareAbort: AbortController | undefined;
  private dumpAbort: AbortController | undefined;
  private disposed = false;

  /** Opens the page, or brings the open one forward on the section asked for. */
  static show(deps: ManagerPanelDeps): ManagerPanel {
    const existing = ManagerPanel.open.get(deps.connectionId);
    if (existing !== undefined) {
      existing.panel.reveal();
      existing.navigate(deps.start);
      return existing;
    }
    const panel = new ManagerPanel(deps);
    ManagerPanel.open.set(deps.connectionId, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...ManagerPanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: ManagerPanelDeps) {
    this.log = deps.logger.child('manager');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ManagerPanel.viewType,
      title: vscode.l10n.t('Manager: {0}', deps.connectionName),
      app: 'manager',
    });
    this.rpc = new RpcPeer({
      local: managerProtocol.host,
      remote: managerProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.handleMonitor();
    this.handleCompare();
    this.handleLog();
    this.handleDump();
    this.handleSync();
    this.handleTableNav();
    this.rpc.on('ready', () => {
      this.sendState();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private navigate(start: ManagerStart): void {
    this.deps.model.setStart(start);
    this.sendState();
  }

  private sendState(): void {
    try {
      const state = this.deps.model.state();
      if (!this.disposed) {
        this.rpc.emit('state', state);
      }
    } catch (error) {
      this.log.warn('Reading the page state failed', error);
    }
  }

  // ── Dashboard and ProcessList: the server monitor's model ──────────────────

  private get monitor(): ServerMonitorModel {
    this.monitorModel ??= this.deps.monitor();
    return this.monitorModel;
  }

  private handleMonitor(): void {
    const { rpc } = this;
    rpc.handle('monitor.processes', async () => await this.monitor.processes());
    rpc.handle('monitor.settings', async ({ scope }) => ({
      rows: await this.monitor.settings(scope),
    }));
    rpc.handle('monitor.status', async () => await this.monitor.status());
    rpc.handle('monitor.stop', async ({ id, kind }) => {
      const process = this.monitor.process(id);
      if (
        process !== undefined &&
        !(await confirmStop(process, kind, {
          name: this.deps.connectionName,
          production: this.deps.production,
        }))
      ) {
        return { stopped: false };
      }
      const stopped = await this.monitor.stop(id, kind);
      if (!stopped) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('The process {0} had already finished', id),
        );
      }
      return { stopped };
    });
    rpc.on('monitor.ready', () => {
      void this.sendMonitorState();
    });
  }

  private async sendMonitorState(): Promise<void> {
    const model = this.monitor;
    if (!model.started) {
      this.monitorStarting ??= model.start();
      await this.monitorStarting;
    }
    if (!this.disposed) {
      this.rpc.emit('monitor.state', model.state());
    }
  }

  // ── Structure Sync: the schema comparison's model ──────────────────────────

  private handleCompare(): void {
    const { rpc } = this;
    const model = (): NonNullable<ManagerModel['compareModel']> => {
      const compare = this.deps.model.compareModel;
      if (compare === undefined) {
        throw new Error('No comparison is running');
      }
      return compare;
    };
    rpc.handle('compare.detail', ({ id }) => model().detail(id));
    rpc.handle('compare.openScript', async ({ ids }) => {
      const compare = model();
      const side = compare.targetSide;
      await this.deps.openScript(compare.script(ids), side.connectionId, side.scope.database);
      return { opened: true };
    });
    rpc.on('compare.ready', () => {
      const compare = this.deps.model.compareModel;
      if (compare === undefined) {
        return;
      }
      if (compare.loaded || this.compareAbort !== undefined) {
        this.sendCompare();
      } else {
        void this.loadCompare();
      }
    });
    rpc.on('compare.refresh', () => {
      if (this.compareAbort === undefined && this.deps.model.compareModel !== undefined) {
        this.deps.invalidate();
        void this.loadCompare();
      }
    });
    rpc.on('compare.swap', () => {
      if (this.compareAbort === undefined) {
        this.deps.model.compareModel?.swap();
        void this.loadCompare();
      }
    });
  }

  private async loadCompare(): Promise<void> {
    const compare = this.deps.model.compareModel;
    if (compare === undefined) {
      return;
    }
    const abort = new AbortController();
    this.compareAbort = abort;
    let shownAt = 0;
    try {
      await compare.load({
        signal: abort.signal,
        onProgress: (state) => {
          const now = Date.now();
          if (now - shownAt >= COMPARE_PROGRESS_INTERVAL_MS && !this.disposed) {
            shownAt = now;
            this.rpc.emit('compare.state', state);
          }
        },
      });
    } catch (error) {
      if (!(isDbError(error) && error.code === 'cancelled')) {
        this.log.warn('Comparing the schemas failed', error);
      }
    } finally {
      this.compareAbort = undefined;
    }
    this.sendCompare();
  }

  private sendCompare(): void {
    const compare = this.deps.model.compareModel;
    if (!this.disposed && compare !== undefined) {
      this.rpc.emit('compare.state', compare.state());
    }
  }

  private handleSync(): void {
    const { rpc } = this;
    rpc.handle('sync.options', () => ({ connections: this.deps.model.syncConnections() }));
    rpc.handle(
      'sync.scopes',
      async ({ connectionId, database }) =>
        await this.deps.model.syncScopes(connectionId, database),
    );
    rpc.handle('sync.start', async ({ source, target }) => {
      this.compareAbort?.abort();
      await this.deps.model.startSync(source, target);
      return { started: true };
    });
  }

  // ── The table bar: the other pages of the table the page was opened from ───

  private handleTableNav(): void {
    this.rpc.on('tableNav', ({ action }) => {
      const view = this.deps.model.tableView();
      if (view === undefined || action === 'manager') {
        return;
      }
      const call = tableActionCall(action, view);
      // A dump that is still being written keeps this page: the target opens in its own tab.
      const run =
        this.dumpAbort === undefined
          ? navigateTable(this.panel, call, false)
          : Promise.resolve(vscode.commands.executeCommand(call.command, ...call.args)).then(
              () => undefined,
            );
      void run.catch((error: unknown) => {
        this.log.warn(`Opening the ${action} page failed`, error);
      });
    });
  }

  // ── Log ────────────────────────────────────────────────────────────────────

  private handleLog(): void {
    const { rpc } = this;
    rpc.handle('log.list', () => ({ entries: this.deps.model.log() }));
    rpc.handle('log.clear', async () => {
      const clear = vscode.l10n.t('Clear');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Forget the statements of "{0}"?', this.deps.connectionName),
        { modal: true, detail: vscode.l10n.t('They are removed from the query history too.') },
        clear,
      );
      if (answer !== clear) {
        return { cleared: false };
      }
      this.deps.model.clearLog();
      return { cleared: true };
    });
    this.subscriptions.push(
      this.deps.onHistoryChange(() => {
        if (!this.disposed) {
          this.rpc.emit('log.changed', {});
        }
      }),
    );
  }

  // ── Dump ───────────────────────────────────────────────────────────────────

  private handleDump(): void {
    const { rpc, deps } = this;
    rpc.handle('dump.options', async (picked) => {
      return await deps.model.dumpOptions(picked, deps.folder());
    });
    rpc.handle('dump.browse', async ({ output }) => {
      const file = await vscode.window.showSaveDialog({
        title: vscode.l10n.t('Dump to SQL File'),
        defaultUri: vscode.Uri.file(output),
        filters: { SQL: ['sql'] },
      });
      return file === undefined ? {} : { output: file.fsPath };
    });
    rpc.on('dump.cancel', () => {
      this.dumpAbort?.abort();
    });
    rpc.handle('dump.run', async (request) => {
      if (this.dumpAbort !== undefined) {
        throw new Error(vscode.l10n.t('A dump is already running'));
      }
      const abort = new AbortController();
      this.dumpAbort = abort;
      const name = request.schema ?? request.database ?? deps.connectionName;
      const path = expandOutput(request.output, name, new Date(), deps.folder());
      let sink: DumpSink | undefined;
      try {
        await mkdir(dirname(path), { recursive: true });
        sink = await deps.model.openSink(path);
        let shownAt = 0;
        const report = await deps.model.dump({ ...request, output: path }, sink, {
          signal: abort.signal,
          onProgress: (state) => {
            const now = Date.now();
            if (now - shownAt >= PROGRESS_INTERVAL_MS && !this.disposed) {
              shownAt = now;
              this.rpc.emit('dump.progress', {
                ...(state.table === undefined ? {} : { table: state.table }),
                rows: state.rows,
                tablesDone: state.tablesDone,
                tablesTotal: state.tablesTotal,
              });
            }
          },
        });
        await sink.close();
        this.log.info(
          `Dump of ${deps.connectionName} written to ${path} (${formatSize(report.bytes)})`,
        );
        return report;
      } catch (error) {
        await sink?.discard();
        if (isDbError(error) && error.code === 'cancelled') {
          throw new Error(vscode.l10n.t('The dump was cancelled'), { cause: error });
        }
        throw error;
      } finally {
        this.dumpAbort = undefined;
      }
    });
    rpc.handle('dump.reveal', async ({ path, how }) => {
      const file = vscode.Uri.file(path);
      if (how === 'open') {
        await vscode.window.showTextDocument(file);
      } else {
        await vscode.commands.executeCommand('revealFileInOS', file);
      }
      return { done: true };
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ManagerPanel.open.delete(this.deps.connectionId);
    this.compareAbort?.abort();
    this.dumpAbort?.abort();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.rpc.dispose();
    this.panel.dispose();
    void this.deps.release().catch((error: unknown) => {
      this.log.warn('Closing the page session failed', error);
    });
  }
}

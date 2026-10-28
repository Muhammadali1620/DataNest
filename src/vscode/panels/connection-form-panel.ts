import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import {
  connectionFormProtocol,
  type ConnectionDraft,
  type ConnectionFormProtocol,
} from '../../shared/protocols/connection-form';
import { RpcPeer } from '../../shared/rpc';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { ConnectionInput } from '../../shared/connection';
import {
  driverOptions,
  NEW_CONNECTION,
  storedSshFlags,
  testSshSecrets,
  toInput,
  toPasswordChange,
  toSshChanges,
} from './connection-form-state';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

/** What a new form starts with instead of the defaults, e.g. a parsed URL. */
export interface ConnectionPrefill {
  readonly input: ConnectionInput;
  /** Stays in the host; the page only learns that there is one. */
  readonly password?: string;
}

export interface ConnectionFormDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
}

/** The create/edit form. One panel per connection, reused if already open. */
export class ConnectionFormPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.connectionForm';

  private static readonly open = new Map<string, ConnectionFormPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly deps: ConnectionFormDeps;
  private readonly rpc: RpcPeer<ConnectionFormProtocol['host'], ConnectionFormProtocol['webview']>;
  private readonly log: Logger;
  private connectionId: string | undefined;
  private prefill: ConnectionPrefill | undefined;
  private disposed = false;

  /**
   * Opens the form for a saved connection, or for a new one when `connectionId` is
   * absent; a new one may start from `prefill` (an open new form takes it over).
   */
  static show(
    deps: ConnectionFormDeps,
    connectionId?: string,
    prefill?: ConnectionPrefill,
  ): ConnectionFormPanel {
    const key = connectionId ?? '';
    const existing = ConnectionFormPanel.open.get(key);
    if (existing && !existing.disposed) {
      if (prefill !== undefined && existing.connectionId === undefined) {
        existing.prefill = prefill;
        existing.sendState();
      }
      existing.panel.reveal();
      return existing;
    }
    const panel = new ConnectionFormPanel(deps, connectionId);
    panel.prefill = connectionId === undefined ? prefill : undefined;
    ConnectionFormPanel.open.set(key, panel);
    return panel;
  }

  /** Closes every open form; used when the extension shuts down. */
  static disposeAll(): void {
    for (const panel of [...ConnectionFormPanel.open.values()]) {
      panel.dispose();
    }
    ConnectionFormPanel.open.clear();
  }

  private constructor(deps: ConnectionFormDeps, connectionId: string | undefined) {
    this.deps = deps;
    this.connectionId = connectionId;
    this.log = deps.logger.child('connection-form');
    const config = connectionId === undefined ? undefined : deps.store.get(connectionId);
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ConnectionFormPanel.viewType,
      title:
        config === undefined
          ? vscode.l10n.t('New Connection')
          : vscode.l10n.t('Connection: {0}', config.name),
      app: 'connection-form',
    });
    this.rpc = new RpcPeer({
      local: connectionFormProtocol.host,
      remote: connectionFormProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('test', async (draft) => {
      await this.test(draft);
      return {};
    });
    this.rpc.handle('save', async (draft) => ({ connectionId: await this.save(draft) }));
    this.rpc.handle('pickFile', async ({ create }) => await pickDatabaseFile(create));
    this.rpc.handle('pickKeyFile', async () => await pickKeyFile());
    this.rpc.handle('pickTlsFile', async () => await pickTlsFile());
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      this.sendState();
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [key, panel] of ConnectionFormPanel.open) {
      if (panel === this) {
        ConnectionFormPanel.open.delete(key);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async test(draft: ConnectionDraft): Promise<void> {
    const password = await this.resolveTestPassword(draft);
    const stored =
      this.connectionId === undefined ? {} : await this.deps.store.getSshSecrets(this.connectionId);
    await this.deps.manager.test(draft.input, password, testSshSecrets(draft, stored));
  }

  /** "Test" must work while editing without retyping a stored password. */
  private async resolveTestPassword(draft: ConnectionDraft): Promise<string | undefined> {
    if (draft.password.kind === 'set') {
      return draft.password.value;
    }
    if (draft.password.kind === 'clear') {
      return undefined;
    }
    if (this.connectionId === undefined) {
      return this.prefill?.password;
    }
    return await this.deps.store.getPassword(this.connectionId);
  }

  private async save(draft: ConnectionDraft): Promise<string> {
    const change = toPasswordChange(draft);
    if (this.connectionId === undefined) {
      const created = await this.deps.store.add(
        draft.input,
        change.kind === 'set'
          ? change.value
          : change.kind === 'keep'
            ? this.prefill?.password
            : undefined,
        testSshSecrets(draft, {}),
      );
      this.connectionId = created.id;
      this.prefill = undefined;
      this.retitle(created.name);
      this.sendState();
      return created.id;
    }
    const updated = await this.deps.store.update(
      this.connectionId,
      draft.input,
      change,
      toSshChanges(draft),
    );
    this.retitle(updated.name);
    this.sendState();
    return updated.id;
  }

  private retitle(name: string): void {
    this.panel.title = vscode.l10n.t('Connection: {0}', name);
  }

  private sendState(): void {
    void this.pushState();
  }

  private async pushState(): Promise<void> {
    const { connectionId } = this;
    const config = connectionId === undefined ? undefined : this.deps.store.get(connectionId);
    const hasStoredPassword =
      connectionId === undefined
        ? false
        : (await this.deps.store.getPassword(connectionId)) !== undefined;
    const storedSsh =
      connectionId === undefined ? {} : await this.deps.store.getSshSecrets(connectionId);
    // The panel may have been closed while the secret was read; stay silent then.
    if (this.disposed) {
      return;
    }
    this.rpc.emit('state', {
      ...(connectionId === undefined ? {} : { connectionId }),
      input: config === undefined ? (this.prefill?.input ?? NEW_CONNECTION) : toInput(config),
      hasStoredPassword,
      ...(this.prefill?.password === undefined ? {} : { importedPassword: true }),
      storedSsh: storedSshFlags(storedSsh),
      drivers: driverOptions(),
    });
  }
}

async function pickDatabaseFile(create: boolean): Promise<{ file?: string }> {
  const filters = { [vscode.l10n.t('SQLite database')]: ['db', 'sqlite', 'sqlite3', 'db3'] };
  if (create) {
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('New SQLite Database'),
      filters,
    });
    return target === undefined ? {} : { file: target.fsPath };
  }
  const chosen = await vscode.window.showOpenDialog({
    title: vscode.l10n.t('Open SQLite Database'),
    canSelectMany: false,
    filters,
  });
  const first = chosen?.[0];
  return first === undefined ? {} : { file: first.fsPath };
}

async function pickKeyFile(): Promise<{ file?: string }> {
  const ssh = vscode.Uri.joinPath(vscode.Uri.file(homedir()), '.ssh');
  const chosen = await vscode.window.showOpenDialog({
    title: vscode.l10n.t('SSH Private Key'),
    canSelectMany: false,
    defaultUri: ssh,
  });
  const first = chosen?.[0];
  return first === undefined ? {} : { file: first.fsPath };
}

async function pickTlsFile(): Promise<{ file?: string }> {
  const chosen = await vscode.window.showOpenDialog({
    title: vscode.l10n.t('Certificate or Key'),
    canSelectMany: false,
    filters: {
      [vscode.l10n.t('Certificates and keys')]: ['pem', 'crt', 'cer', 'key'],
      [vscode.l10n.t('All files')]: ['*'],
    },
  });
  const first = chosen?.[0];
  return first === undefined ? {} : { file: first.fsPath };
}

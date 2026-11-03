import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { serverFormProtocol, type ServerFormProtocol } from '../../shared/protocols/server-form';
import { RpcPeer } from '../../shared/rpc';
import { pickKeyFile } from './connection-form-panel';
import { ServerFormModel, type ServerFormModelDeps } from './server-form-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface ServerFormDeps extends ServerFormModelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
}

/** The form of an SSH server: one panel per saved server, one for all new ones. */
export class ServerFormPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.serverForm';

  private static readonly open = new Map<string, ServerFormPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ServerFormProtocol['host'], ServerFormProtocol['webview']>;
  private readonly model: ServerFormModel;
  private readonly log: Logger;
  private disposed = false;

  /** Opens the form for a saved server, or a blank one; an open form is brought forward. */
  static show(deps: ServerFormDeps, serverId?: string): ServerFormPanel {
    const key = serverId ?? '';
    const existing = ServerFormPanel.open.get(key);
    if (existing && !existing.disposed) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new ServerFormPanel(deps, serverId);
    ServerFormPanel.open.set(key, panel);
    return panel;
  }

  /** Closes every open form; used when the extension shuts down. */
  static disposeAll(): void {
    for (const panel of [...ServerFormPanel.open.values()]) {
      panel.dispose();
    }
    ServerFormPanel.open.clear();
  }

  private constructor(deps: ServerFormDeps, serverId: string | undefined) {
    this.model = new ServerFormModel(deps, serverId);
    this.log = deps.logger.child('server-form');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ServerFormPanel.viewType,
      title: this.title(),
      app: 'server-form',
    });
    this.rpc = new RpcPeer({
      local: serverFormProtocol.host,
      remote: serverFormProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    this.rpc.handle('test', async (draft) => await this.model.test(draft));
    this.rpc.handle('save', async (draft) => {
      const wasNew = this.model.id === undefined;
      const id = await this.model.save(draft);
      this.panel.title = this.title();
      if (wasNew) {
        // The form now belongs to a saved server: a second "New Server" opens a blank one.
        ServerFormPanel.open.delete('');
        ServerFormPanel.open.set(id, this);
      }
      void this.sendState();
      return { serverId: id };
    });
    this.rpc.handle('pickKeyFile', async () => await pickKeyFile());
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      void this.sendState();
    });
    this.rpc.on('close', () => {
      this.dispose();
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
    for (const [key, panel] of ServerFormPanel.open) {
      if (panel === this) {
        ServerFormPanel.open.delete(key);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private title(): string {
    const name = this.model.name;
    return name === '' ? vscode.l10n.t('New Server') : vscode.l10n.t('Server: {0}', name);
  }

  private async sendState(): Promise<void> {
    const state = await this.model.state();
    // The panel may have been closed while the secrets were read; stay silent then.
    if (!this.disposed) {
      this.rpc.emit('state', state);
    }
  }
}

// The users and privileges page (V8.6): one panel per connection and database, with a
// session of its own. A change is previewed on the page and run only on request; on a
// production connection the host asks once more.

import * as vscode from 'vscode';
import { DbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { RpcPeer } from '../../shared/rpc';
import { userAdminProtocol, type UserAdminProtocol } from '../../shared/protocols/user-admin';
import { UserAdminModel } from './user-admin-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';
import { msg } from '../../core/user-message';

export interface UserAdminPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly model: UserAdminModel;
  readonly key: string;
  readonly title: string;
  readonly connectionName: string;
  readonly production: boolean;
  /** Opens statements in a SQL editor on the same connection. */
  readonly openEditor: (sql: string) => Promise<void>;
  /** Closes the page's session. */
  readonly release: () => Promise<void>;
}

export class UserAdminPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.userAdmin';

  private static readonly open = new Map<string, UserAdminPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<UserAdminProtocol['host'], UserAdminProtocol['webview']>;
  private readonly log: Logger;
  private starting: Promise<void> | undefined;
  private disposed = false;

  static show(deps: UserAdminPanelDeps): UserAdminPanel {
    const existing = UserAdminPanel.open.get(deps.key);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }
    const panel = new UserAdminPanel(deps);
    UserAdminPanel.open.set(deps.key, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...UserAdminPanel.open.values()]) {
      panel.dispose();
    }
  }

  private constructor(private readonly deps: UserAdminPanelDeps) {
    this.log = deps.logger.child('user-admin');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: UserAdminPanel.viewType,
      title: deps.title,
      app: 'user-admin',
    });
    this.rpc = new RpcPeer({
      local: userAdminProtocol.host,
      remote: userAdminProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    const { model } = deps;
    this.rpc.handle('users', async () => ({ rows: await model.users() }));
    this.rpc.handle('grants', async ({ user }) => ({ rows: await model.grants(user) }));
    this.rpc.handle('objects', async ({ kind, database, schema }) => ({
      names: await model.objects(kind, database, schema),
    }));
    this.rpc.handle('preview', ({ change }) => ({
      statements: [...model.statements(change).preview],
    }));
    this.rpc.handle('run', async ({ change }) => {
      const count = model.statements(change).statements.length;
      if (deps.production) {
        const run = vscode.l10n.t('Run on Production');
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Run {0} statements on the production connection "{1}"?',
            count,
            deps.connectionName,
          ),
          { modal: true },
          run,
        );
        if (answer !== run) {
          return { done: false };
        }
      }
      await model.run(change);
      return { done: true };
    });
    this.rpc.handle('openInEditor', async ({ change }) => {
      if (UserAdminModel.hasPassword(change)) {
        throw new DbError(
          'unsupported',
          msg('A statement with a password is not written to an editor; run it from the page'),
        );
      }
      await deps.openEditor(`${model.statements(change).statements.join(';\n')};\n`);
      return {};
    });
    this.rpc.on('ready', () => {
      void this.sendState();
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  private async sendState(): Promise<void> {
    if (!this.deps.model.started) {
      this.starting ??= this.deps.model.start();
      await this.starting;
    }
    if (!this.disposed) {
      this.rpc.emit('state', this.deps.model.state());
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    UserAdminPanel.open.delete(this.deps.key);
    this.rpc.dispose();
    this.panel.dispose();
    void this.deps.release().catch((error: unknown) => {
      this.log.warn('Closing the users session failed', error);
    });
  }
}

// The etcd key page (V13.19): one panel per key. It asks before every change on a
// production connection, always before deleting the key or revoking a lease, and tells
// the tree when a key appears or goes.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { changeVerdict, type WritePolicy } from '../../services/write-policy';
import {
  type EtcdKeyProtocol,
  etcdKeyProtocol,
  type EtcdKeyState,
} from '../../shared/protocols/etcd-key';
import { type RedisKeyRef, redisKeyId } from '../../shared/redis-key';
import { RpcPeer } from '../../shared/rpc';
import type { EtcdKeyModel } from './etcd-key-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

/** What happened to a key, so the tree can follow. */
export interface EtcdKeyChange {
  readonly connectionId: string;
  readonly key: RedisKeyRef;
  readonly deleted?: boolean;
  readonly created?: boolean;
}

export interface EtcdKeyPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly connectionId: string;
  readonly model: EtcdKeyModel;
  readonly policy: WritePolicy;
  readonly onChanged: (change: EtcdKeyChange) => void;
}

/** Long names are cut in the tab title; the page shows them whole. */
function titleOf(key: RedisKeyRef): string {
  const name = key.text.slice(key.text.lastIndexOf('/') + 1) || key.text;
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

export class EtcdKeyPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.etcdKey';

  private static readonly open = new Map<string, EtcdKeyPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<EtcdKeyProtocol['host'], EtcdKeyProtocol['webview']>;
  private readonly log: Logger;
  private state: EtcdKeyState | undefined;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Opens the page of a key, or brings its open page forward and reads it again. */
  static show(deps: EtcdKeyPanelDeps): EtcdKeyPanel {
    const id = EtcdKeyPanel.idOf(deps.connectionId, deps.model.currentKey);
    const existing = EtcdKeyPanel.open.get(id);
    if (existing !== undefined && !existing.disposed) {
      existing.panel.reveal();
      void existing.reload();
      return existing;
    }
    const panel = new EtcdKeyPanel(deps);
    EtcdKeyPanel.open.set(id, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...EtcdKeyPanel.open.values()]) {
      panel.dispose();
    }
    EtcdKeyPanel.open.clear();
  }

  private static idOf(connectionId: string, key: RedisKeyRef): string {
    return `${connectionId}\u0000${redisKeyId(key)}`;
  }

  private constructor(private readonly deps: EtcdKeyPanelDeps) {
    this.log = deps.logger.child('etcd-key');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: EtcdKeyPanel.viewType,
      title: titleOf(deps.model.currentKey),
      app: 'etcd-key',
    });
    this.rpc = new RpcPeer({
      local: etcdKeyProtocol.host,
      remote: etcdKeyProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    const model = deps.model;
    this.rpc.handle('refresh', async () => {
      this.push(await model.refresh());
      return {};
    });
    this.rpc.handle('save', async ({ value, modRevision, overwrite }) => {
      if (!(await this.allowed(vscode.l10n.t('Change')))) {
        return { saved: false };
      }
      const existed = this.state?.exists === true;
      const result = await model.save(value, modRevision, overwrite === true);
      this.push(result.state);
      if (result.saved && !existed) {
        this.notify({ created: true });
      }
      return { saved: result.saved };
    });
    this.rpc.handle('attachLease', async ({ ttl, id }) => {
      if (await this.allowed(vscode.l10n.t('Change'))) {
        this.push(
          await model.attachLease({
            ...(ttl === undefined ? {} : { ttl }),
            ...(id === undefined ? {} : { id }),
          }),
        );
      }
      return {};
    });
    this.rpc.handle('keepAlive', async ({ on }) => {
      if (on && !(await this.allowed(vscode.l10n.t('Keep alive')))) {
        return {};
      }
      this.push(model.setKeepAlive(on));
      return {};
    });
    this.rpc.handle('watch', async ({ on, prefix }) => {
      this.push(
        on
          ? await model.startWatch(prefix === true, () => {
              this.push(model.state());
            })
          : model.stopWatch(),
      );
      return {};
    });
    this.rpc.handle('clearEvents', () => {
      this.push(model.clearEvents());
      return Promise.resolve({});
    });
    this.rpc.handle('detachLease', async () => {
      if (await this.allowed(vscode.l10n.t('Change'))) {
        this.push(await model.detachLease());
      }
      return {};
    });
    this.rpc.handle('revokeLease', async () => ({ revoked: await this.revokeLease() }));
    this.rpc.handle('deleteKey', async () => ({ deleted: await this.deleteKey() }));
    this.rpc.handle('copyText', async ({ text }) => {
      await vscode.env.clipboard.writeText(text);
      return {};
    });
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      if (this.state === undefined) {
        void this.reload();
      } else {
        this.rpc.emit('state', this.state);
      }
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  /** Renews the lease every third of the time it was granted for, while the model asks. */
  private arm(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.disposed || !this.deps.model.keepingAlive) {
      return;
    }
    const granted = this.state?.lease?.grantedTtl ?? 0;
    const every = Math.min(60_000, Math.max(1000, Math.round((granted * 1000) / 3)));
    this.timer = setInterval(() => {
      if (!this.deps.model.keepingAlive) {
        this.arm();
        return;
      }
      void this.deps.model.renew().then(
        (state) => {
          this.push(state);
        },
        (error: unknown) => {
          // A link that failed ends the renewal; the user sees the reason and can restart it.
          this.log.warn('Renewing the lease failed', error);
          this.push(this.deps.model.setKeepAlive(false));
          void vscode.window.showErrorMessage(
            vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
          );
        },
      );
    }, every);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.deps.model.stopWatch();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const [id, panel] of EtcdKeyPanel.open) {
      if (panel === this) {
        EtcdKeyPanel.open.delete(id);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async reload(): Promise<void> {
    try {
      this.push(await this.deps.model.refresh());
    } catch (error) {
      this.log.warn('Reading the key failed', error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private push(state: EtcdKeyState): void {
    this.state = state;
    if (!this.disposed) {
      this.rpc.emit('state', state);
    }
    this.arm();
  }

  /** True once the connection allows the change; production asks every time. */
  private async allowed(action: string): Promise<boolean> {
    if (changeVerdict(this.deps.policy) !== 'confirm') {
      return true;
    }
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Change the key "{0}" on the production connection "{1}"?',
        this.deps.model.currentKey.text,
        this.deps.policy.name,
      ),
      { modal: true },
      action,
    );
    return answer === action;
  }

  private async revokeLease(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      // The model refuses with the reason; asking first would be pointless.
      await this.deps.model.revokeLease();
    }
    const revoke = vscode.l10n.t('Revoke');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Revoke the lease of the key "{0}"?', this.deps.model.currentKey.text),
      {
        modal: true,
        detail: vscode.l10n.t(
          'Every key attached to the lease is deleted with it, not only this one.',
        ),
      },
      revoke,
    );
    if (answer !== revoke) {
      return false;
    }
    this.push(await this.deps.model.revokeLease());
    this.notify({ deleted: this.state?.exists !== true });
    return true;
  }

  private async deleteKey(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      await this.deps.model.deleteKey();
    }
    const remove = vscode.l10n.t('Delete');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete the key "{0}"?', this.deps.model.currentKey.text),
      {
        modal: true,
        ...(this.deps.policy.production
          ? { detail: vscode.l10n.t('"{0}" is a production connection.', this.deps.policy.name) }
          : {}),
      },
      remove,
    );
    if (answer !== remove) {
      return false;
    }
    this.push(await this.deps.model.deleteKey());
    this.notify({ deleted: true });
    return true;
  }

  private notify(change: { readonly deleted?: boolean; readonly created?: boolean }): void {
    this.deps.onChanged({
      connectionId: this.deps.connectionId,
      key: this.deps.model.currentKey,
      ...change,
    });
  }
}

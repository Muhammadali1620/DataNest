// The Redis key page (V7.3): one panel per key. It asks before every change on a
// production connection, always before deleting the key or replacing another one by a
// rename, and tells the tree when a key appears, moves or goes.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { changeVerdict, type WritePolicy } from '../../services/write-policy';
import { RpcPeer } from '../../shared/rpc';
import {
  type RedisKeyProtocol,
  redisKeyProtocol,
  type RedisKeyState,
} from '../../shared/protocols/redis-key';
import { type RedisKeyRef, redisKeyId } from '../../shared/redis-key';
import type { RedisKeyEdit, RedisKeyModel } from './redis-key-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

/** What happened to a key, so the tree can follow. */
export interface RedisKeyChange {
  readonly connectionId: string;
  readonly database: number;
  readonly key: RedisKeyRef;
  /** The name it had before a rename. */
  readonly renamedFrom?: RedisKeyRef;
  readonly deleted?: boolean;
}

export interface RedisKeyPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly connectionId: string;
  readonly database: number;
  readonly model: RedisKeyModel;
  readonly policy: WritePolicy;
  readonly onChanged: (change: RedisKeyChange) => void;
}

/** Long names are cut in the tab title; the page shows them whole. */
function titleOf(key: RedisKeyRef): string {
  return key.text.length > 60 ? `${key.text.slice(0, 57)}…` : key.text;
}

export class RedisKeyPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.redisKey';

  private static readonly open = new Map<string, RedisKeyPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<RedisKeyProtocol['host'], RedisKeyProtocol['webview']>;
  private readonly log: Logger;
  private state: RedisKeyState | undefined;
  private disposed = false;

  /** Opens the page of a key, or brings its open page forward and reads it again. */
  static show(deps: RedisKeyPanelDeps): RedisKeyPanel {
    const id = RedisKeyPanel.idOf(deps.connectionId, deps.database, deps.model.currentKey);
    const existing = RedisKeyPanel.open.get(id);
    if (existing !== undefined && !existing.disposed) {
      existing.panel.reveal();
      void existing.reload(false);
      return existing;
    }
    const panel = new RedisKeyPanel(deps);
    RedisKeyPanel.open.set(id, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...RedisKeyPanel.open.values()]) {
      panel.dispose();
    }
    RedisKeyPanel.open.clear();
  }

  private static idOf(connectionId: string, database: number, key: RedisKeyRef): string {
    return `${connectionId}\u0000${database}\u0000${redisKeyId(key)}`;
  }

  private constructor(private readonly deps: RedisKeyPanelDeps) {
    this.log = deps.logger.child('redis-key');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: RedisKeyPanel.viewType,
      title: titleOf(deps.model.currentKey),
      app: 'redis-key',
    });
    this.rpc = new RpcPeer({
      local: redisKeyProtocol.host,
      remote: redisKeyProtocol.webview,
      transport: webviewTransport(this.panel.webview, this.log),
      onProtocolError: (problem) => {
        this.log.warn(problem);
      },
    });
    const model = deps.model;
    this.rpc.handle('refresh', async () => {
      this.push(await model.refresh(true));
      return {};
    });
    this.rpc.handle('loadMore', async () => {
      this.push(await model.loadMore());
      return {};
    });
    this.rpc.handle('filter', async ({ pattern }) => {
      this.push(await model.filter(pattern));
      return {};
    });
    this.rpc.handle(
      'setString',
      async (params) => await this.ran({ kind: 'setString', ...params }),
    );
    this.rpc.handle('setField', async (params) => await this.ran({ kind: 'setField', ...params }));
    this.rpc.handle(
      'deleteField',
      async (params) => await this.ran({ kind: 'deleteField', ...params }),
    );
    this.rpc.handle(
      'setListItem',
      async (params) => await this.ran({ kind: 'setListItem', ...params }),
    );
    this.rpc.handle(
      'pushListItem',
      async (params) => await this.ran({ kind: 'pushListItem', ...params }),
    );
    this.rpc.handle(
      'removeListItem',
      async (params) => await this.ran({ kind: 'removeListItem', ...params }),
    );
    this.rpc.handle(
      'setMember',
      async (params) => await this.ran({ kind: 'setMember', ...params }),
    );
    this.rpc.handle(
      'deleteMember',
      async ({ value }) => await this.ran({ kind: 'deleteMember', value }),
    );
    this.rpc.handle(
      'setScoredMember',
      async (params) => await this.ran({ kind: 'setScoredMember', ...params }),
    );
    this.rpc.handle('addEntry', async (params) => await this.ran({ kind: 'addEntry', ...params }));
    this.rpc.handle(
      'deleteEntry',
      async (params) => await this.ran({ kind: 'deleteEntry', ...params }),
    );
    this.rpc.handle('setTtl', async (params) => await this.ran({ kind: 'setTtl', ...params }));
    this.rpc.handle('rename', async ({ name }) => ({ renamed: await this.rename(name) }));
    this.rpc.handle('deleteKey', async () => ({ deleted: await this.deleteKey() }));
    // A hidden tab is unloaded, so the page asks for its state on every load (D21).
    this.rpc.on('ready', () => {
      if (this.state === undefined) {
        void this.reload(false);
      } else {
        this.rpc.emit('state', this.state);
      }
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
    for (const [id, panel] of RedisKeyPanel.open) {
      if (panel === this) {
        RedisKeyPanel.open.delete(id);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async reload(keep: boolean): Promise<void> {
    try {
      this.push(await this.deps.model.refresh(keep));
    } catch (error) {
      this.log.warn('Reading the key failed', error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private push(state: RedisKeyState): void {
    this.state = state;
    if (!this.disposed) {
      this.rpc.emit('state', state);
    }
  }

  private async ran(edit: RedisKeyEdit): Promise<Record<string, never>> {
    await this.change(edit);
    return {};
  }

  /** Runs a change once the connection allows it; production asks every time. */
  private async change(edit: RedisKeyEdit): Promise<void> {
    if (!(await this.allowed())) {
      return;
    }
    const existed = this.state?.exists === true;
    this.push(await this.deps.model.apply(edit));
    // An edit may create the key (a push to a key that was deleted) or empty it away.
    if (existed !== this.state?.exists) {
      this.notify(this.state?.exists !== true);
    }
  }

  private async allowed(): Promise<boolean> {
    if (changeVerdict(this.deps.policy) !== 'confirm') {
      return true;
    }
    const go = vscode.l10n.t('Change');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Change the key "{0}" on the production connection "{1}"?',
        this.deps.model.currentKey.text,
        this.deps.policy.name,
      ),
      { modal: true },
      go,
    );
    return answer === go;
  }

  private async rename(name: string): Promise<boolean> {
    if (!(await this.allowed())) {
      return false;
    }
    const before = this.deps.model.currentKey;
    let renamed = await this.deps.model.rename(name, false);
    if (!renamed) {
      const replace = vscode.l10n.t('Replace');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('The key "{0}" already exists. Replace it?', name),
        { modal: true, detail: vscode.l10n.t('Its value is lost.') },
        replace,
      );
      if (answer !== replace) {
        return false;
      }
      renamed = await this.deps.model.rename(name, true);
    }
    if (renamed) {
      const after = this.deps.model.currentKey;
      RedisKeyPanel.open.delete(
        RedisKeyPanel.idOf(this.deps.connectionId, this.deps.database, before),
      );
      RedisKeyPanel.open.set(
        RedisKeyPanel.idOf(this.deps.connectionId, this.deps.database, after),
        this,
      );
      this.panel.title = titleOf(after);
      this.deps.onChanged({
        connectionId: this.deps.connectionId,
        database: this.deps.database,
        key: after,
        renamedFrom: before,
      });
      this.push(this.deps.model.state());
    }
    return renamed;
  }

  private async deleteKey(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      // The model refuses with the reason; asking first would be pointless.
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
    await this.deps.model.deleteKey();
    this.push(this.deps.model.state());
    this.notify(true);
    return true;
  }

  private notify(deleted: boolean): void {
    this.deps.onChanged({
      connectionId: this.deps.connectionId,
      database: this.deps.database,
      key: this.deps.model.currentKey,
      ...(deleted ? { deleted: true } : {}),
    });
  }
}

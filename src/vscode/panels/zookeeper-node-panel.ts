// The ZooKeeper znode page (V13.24): one panel per znode. It asks before every change on a
// production connection, always before deleting a znode, and tells the tree when a znode
// appears or goes.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { changeVerdict, type WritePolicy } from '../../services/write-policy';
import {
  type ZookeeperNodeProtocol,
  zookeeperNodeProtocol,
  type ZookeeperNodeState,
} from '../../shared/protocols/zookeeper-node';
import { RpcPeer } from '../../shared/rpc';
import { joinPath, nameOf } from '../../shared/zk-path';
import type { ZookeeperNodeModel } from './zookeeper-node-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

/** What happened to a znode, so the tree can follow. */
export interface ZookeeperNodeChange {
  readonly connectionId: string;
  readonly path: string;
  readonly deleted?: boolean;
  readonly created?: boolean;
}

export interface ZookeeperNodePanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly connectionId: string;
  readonly model: ZookeeperNodeModel;
  readonly policy: WritePolicy;
  readonly onChanged: (change: ZookeeperNodeChange) => void;
  /** Opens the page of another znode of the same connection. */
  readonly openNode: (path: string) => void;
}

/** Long names are cut in the tab title; the page shows the whole path. */
function titleOf(path: string): string {
  const name = nameOf(path);
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

export class ZookeeperNodePanel implements vscode.Disposable {
  static readonly viewType = 'datanest.zookeeperNode';

  private static readonly open = new Map<string, ZookeeperNodePanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ZookeeperNodeProtocol['host'], ZookeeperNodeProtocol['webview']>;
  private readonly log: Logger;
  private state: ZookeeperNodeState | undefined;
  private disposed = false;

  /** Opens the page of a znode, or brings its open page forward and reads it again. */
  static show(deps: ZookeeperNodePanelDeps): ZookeeperNodePanel {
    const id = ZookeeperNodePanel.idOf(deps.connectionId, deps.model.currentPath);
    const existing = ZookeeperNodePanel.open.get(id);
    if (existing !== undefined && !existing.disposed) {
      existing.panel.reveal();
      void existing.reload();
      return existing;
    }
    const panel = new ZookeeperNodePanel(deps);
    ZookeeperNodePanel.open.set(id, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...ZookeeperNodePanel.open.values()]) {
      panel.dispose();
    }
    ZookeeperNodePanel.open.clear();
  }

  private static idOf(connectionId: string, path: string): string {
    return `${connectionId}\u0000${path}`;
  }

  private constructor(private readonly deps: ZookeeperNodePanelDeps) {
    this.log = deps.logger.child('zookeeper-node');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: ZookeeperNodePanel.viewType,
      title: titleOf(deps.model.currentPath),
      app: 'zookeeper-node',
    });
    this.rpc = new RpcPeer({
      local: zookeeperNodeProtocol.host,
      remote: zookeeperNodeProtocol.webview,
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
    this.rpc.handle('save', async ({ value, version, overwrite }) => {
      if (!(await this.allowed(vscode.l10n.t('Change')))) {
        return { saved: false };
      }
      const existed = this.state?.exists === true;
      const result = await model.save(value, version, overwrite === true);
      this.push(result.state);
      if (result.saved && !existed) {
        this.notify({ created: true });
      }
      return { saved: result.saved };
    });
    this.rpc.handle('createChild', async ({ name, mode }) => {
      if (!(await this.allowed(vscode.l10n.t('Create')))) {
        return { path: joinPath(model.currentPath, name) };
      }
      const path = await model.createChild(name, mode);
      this.push(model.state());
      this.notify({ created: true });
      this.deps.openNode(path);
      return { path };
    });
    this.rpc.handle('openChild', ({ name }) => {
      this.deps.openNode(joinPath(model.currentPath, name));
      return Promise.resolve({});
    });
    this.rpc.handle('deleteNode', async () => ({ deleted: await this.deleteNode() }));
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [id, panel] of ZookeeperNodePanel.open) {
      if (panel === this) {
        ZookeeperNodePanel.open.delete(id);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async reload(): Promise<void> {
    try {
      this.push(await this.deps.model.refresh());
    } catch (error) {
      this.log.warn('Reading the znode failed', error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private push(state: ZookeeperNodeState): void {
    this.state = state;
    if (!this.disposed) {
      this.rpc.emit('state', state);
    }
  }

  /** True once the connection allows the change; production asks every time. */
  private async allowed(action: string): Promise<boolean> {
    if (changeVerdict(this.deps.policy) !== 'confirm') {
      return true;
    }
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Change the znode "{0}" on the production connection "{1}"?',
        this.deps.model.currentPath,
        this.deps.policy.name,
      ),
      { modal: true },
      action,
    );
    return answer === action;
  }

  private async deleteNode(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      // The model refuses with the reason; asking first would be pointless.
      await this.deps.model.deleteNode();
    }
    const remove = vscode.l10n.t('Delete');
    const below = this.state?.numChildren ?? 0;
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete the znode "{0}"?', this.deps.model.currentPath),
      {
        modal: true,
        detail: [
          below > 0
            ? vscode.l10n.t('Its {0} children and everything below them are deleted, too.', below)
            : undefined,
          this.deps.policy.production
            ? vscode.l10n.t('"{0}" is a production connection.', this.deps.policy.name)
            : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join(' '),
      },
      remove,
    );
    if (answer !== remove) {
      return false;
    }
    this.push(await this.deps.model.deleteNode());
    this.notify({ deleted: true });
    return true;
  }

  private notify(change: { readonly deleted?: boolean; readonly created?: boolean }): void {
    this.deps.onChanged({
      connectionId: this.deps.connectionId,
      path: this.deps.model.currentPath,
      ...change,
    });
  }
}

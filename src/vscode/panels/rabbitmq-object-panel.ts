// The RabbitMQ queue and exchange page (V13.26): one panel per object. It asks before
// publishing on a production connection, always before purging or deleting, and tells the
// tree when an object goes.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { changeVerdict, type WritePolicy } from '../../services/write-policy';
import {
  type RabbitObjectProtocol,
  rabbitObjectProtocol,
  type RabbitObjectState,
} from '../../shared/protocols/rabbitmq-object';
import { RpcPeer } from '../../shared/rpc';
import type { RabbitObjectModel } from './rabbitmq-object-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface RabbitObjectPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly connectionId: string;
  readonly model: RabbitObjectModel;
  readonly policy: WritePolicy;
  /** Called after the object was deleted, so the tree can follow. */
  readonly onDeleted: (connectionId: string) => void;
}

function titleOf(name: string): string {
  const shown = name === '' ? '(AMQP default)' : name;
  return shown.length > 60 ? `${shown.slice(0, 57)}…` : shown;
}

export class RabbitObjectPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.rabbitObject';

  private static readonly open = new Map<string, RabbitObjectPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<RabbitObjectProtocol['host'], RabbitObjectProtocol['webview']>;
  private readonly log: Logger;
  private readonly aborts = new Set<AbortController>();
  private state: RabbitObjectState | undefined;
  private disposed = false;

  /** Opens the page of a queue or exchange, or brings its open page forward and reads it again. */
  static show(deps: RabbitObjectPanelDeps): RabbitObjectPanel {
    const { model } = deps;
    const id = `${deps.connectionId}\u0000${model.kind}\u0000${model.vhost}\u0000${model.name}`;
    const existing = RabbitObjectPanel.open.get(id);
    if (existing !== undefined && !existing.disposed) {
      existing.panel.reveal();
      void existing.reload();
      return existing;
    }
    const panel = new RabbitObjectPanel(deps);
    RabbitObjectPanel.open.set(id, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...RabbitObjectPanel.open.values()]) {
      panel.dispose();
    }
    RabbitObjectPanel.open.clear();
  }

  private constructor(private readonly deps: RabbitObjectPanelDeps) {
    this.log = deps.logger.child('rabbitmq-object');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: RabbitObjectPanel.viewType,
      title: titleOf(deps.model.name),
      app: 'rabbitmq-object',
    });
    this.rpc = new RpcPeer({
      local: rabbitObjectProtocol.host,
      remote: rabbitObjectProtocol.webview,
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
    this.rpc.handle('peek', async ({ count }) => {
      const abort = new AbortController();
      this.aborts.add(abort);
      try {
        this.push(await model.peek(count, abort.signal));
      } finally {
        this.aborts.delete(abort);
      }
      return {};
    });
    this.rpc.handle('publish', async (params) => {
      if (!(await this.allowed())) {
        return { published: false };
      }
      const result = await model.publish({
        routingKey: params.routingKey,
        payload: params.payload,
        contentType: params.contentType,
        persistent: params.persistent,
        headers: params.headers,
      });
      this.push(result.state);
      if (result.routed) {
        void vscode.window.showInformationMessage(vscode.l10n.t('The message was published'));
      } else {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('The message was published, but no queue took it'),
        );
      }
      return { published: true, routed: result.routed };
    });
    this.rpc.handle('purge', async () => ({ purged: await this.purge() }));
    this.rpc.handle('deleteObject', async () => ({ deleted: await this.deleteObject() }));
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
    for (const abort of this.aborts) {
      abort.abort();
    }
    for (const [id, panel] of RabbitObjectPanel.open) {
      if (panel === this) {
        RabbitObjectPanel.open.delete(id);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async reload(): Promise<void> {
    try {
      this.push(await this.deps.model.refresh());
    } catch (error) {
      this.log.warn('Reading the object failed', error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private push(state: RabbitObjectState): void {
    this.state = state;
    if (!this.disposed) {
      this.rpc.emit('state', state);
    }
  }

  private label(): string {
    const { model } = this.deps;
    return model.name === '' ? '(AMQP default)' : model.name;
  }

  /** True once the connection allows the change; production asks every time. */
  private async allowed(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      // The model refuses with the reason; asking first would be pointless.
      return true;
    }
    if (changeVerdict(this.deps.policy) !== 'confirm') {
      return true;
    }
    const send = vscode.l10n.t('Publish');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Publish a message to "{0}" on the production connection "{1}"?',
        this.label(),
        this.deps.policy.name,
      ),
      { modal: true },
      send,
    );
    return answer === send;
  }

  private async purge(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      await this.deps.model.purge();
    }
    const remove = vscode.l10n.t('Remove Messages');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Remove all messages of the queue "{0}"?', this.label()),
      { modal: true, detail: vscode.l10n.t('The messages are lost for good.') },
      remove,
    );
    if (answer !== remove) {
      return false;
    }
    await this.deps.model.purge();
    this.push(this.deps.model.state());
    return true;
  }

  private async deleteObject(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      await this.deps.model.deleteObject();
    }
    const remove = vscode.l10n.t('Delete');
    const queue = this.deps.model.kind === 'queue';
    const answer = await vscode.window.showWarningMessage(
      queue
        ? vscode.l10n.t('Delete the queue "{0}"?', this.label())
        : vscode.l10n.t('Delete the exchange "{0}"?', this.label()),
      {
        modal: true,
        detail: queue
          ? vscode.l10n.t('Its messages are lost for good.')
          : vscode.l10n.t('Its bindings go with it.'),
      },
      remove,
    );
    if (answer !== remove) {
      return false;
    }
    await this.deps.model.deleteObject();
    this.deps.onDeleted(this.deps.connectionId);
    this.dispose();
    return true;
  }
}

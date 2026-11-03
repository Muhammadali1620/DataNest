// The RabbitMQ queue, exchange and virtual host page (V13.26, V13.28): one panel per object. It
// asks before a change on a production connection, always before purging, deleting, removing
// or closing, and tells the tree when an object goes.

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

function titleOf(name: string, kind: string): string {
  if (kind === 'cluster') {
    return vscode.l10n.t('RabbitMQ Cluster');
  }
  const shown =
    kind === 'vhost' ? vscode.l10n.t('Broker {0}', name) : name === '' ? '(AMQP default)' : name;
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
      title: titleOf(deps.model.name, deps.model.kind),
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
    this.rpc.handle('addBinding', async (params) => {
      const peer = params.peer.trim();
      const text =
        params.direction === 'fromExchange'
          ? vscode.l10n.t('Bind "{0}" to receive from the exchange "{1}"?', this.label(), peer)
          : vscode.l10n.t('Bind the exchange "{0}" to "{1}"?', this.label(), peer);
      return await this.change(text, vscode.l10n.t('Bind'), false, async () =>
        model.addBinding(params),
      );
    });
    this.rpc.handle('removeBinding', async ({ index }) => {
      const binding = model.bindingAt(index);
      const text =
        binding === undefined
          ? vscode.l10n.t('Remove this binding?')
          : vscode.l10n.t(
              'Remove the binding from "{0}" to "{1}" with the key "{2}"?',
              binding.source,
              binding.destination,
              binding.routingKey,
            );
      return await this.change(text, vscode.l10n.t('Remove'), true, async () =>
        model.removeBinding(index),
      );
    });
    this.rpc.handle('closeConnection', async ({ name }) =>
      this.change(
        vscode.l10n.t('Close the connection "{0}"?', name),
        vscode.l10n.t('Close Connection'),
        true,
        async () => model.closeConnection(name),
        vscode.l10n.t('Its client loses the link; most clients connect again.'),
      ),
    );
    this.rpc.handle('createUser', async ({ name, password, tags }) =>
      this.change(
        vscode.l10n.t('Create the user "{0}"?', name),
        vscode.l10n.t('Create'),
        false,
        async () => model.createUser(name, password, tags),
      ),
    );
    this.rpc.handle('updateUser', async ({ name, password, tags }) =>
      this.change(
        password === undefined
          ? vscode.l10n.t('Change the tags of the user "{0}"?', name)
          : vscode.l10n.t('Change the password of the user "{0}"?', name),
        vscode.l10n.t('Change'),
        password !== undefined,
        async () => model.updateUser(name, { password, tags }),
        password === undefined
          ? undefined
          : vscode.l10n.t('Clients that use the old password cannot sign in any more.'),
      ),
    );
    this.rpc.handle('deleteUser', async ({ name }) =>
      this.change(
        vscode.l10n.t('Delete the user "{0}"?', name),
        vscode.l10n.t('Delete'),
        true,
        async () => model.deleteUser(name),
        vscode.l10n.t('The user loses its permissions in every virtual host.'),
      ),
    );
    this.rpc.handle('setPermission', async ({ user, ...permission }) =>
      this.change(
        vscode.l10n.t('Change what "{0}" may do in the virtual host "{1}"?', user, model.name),
        vscode.l10n.t('Change'),
        false,
        async () => model.setPermission(user, permission),
      ),
    );
    this.rpc.handle('clearPermission', async ({ user }) =>
      this.change(
        vscode.l10n.t('Take away all access of "{0}" to the virtual host "{1}"?', user, model.name),
        vscode.l10n.t('Take Away'),
        true,
        async () => model.clearPermission(user),
      ),
    );
    this.rpc.handle('setPolicy', async (params) =>
      this.change(
        params.operator === true
          ? vscode.l10n.t(
              'Save the operator policy "{0}" in the virtual host "{1}"?',
              params.name,
              model.name,
            )
          : vscode.l10n.t(
              'Save the policy "{0}" in the virtual host "{1}"?',
              params.name,
              model.name,
            ),
        vscode.l10n.t('Save'),
        false,
        async () => model.setPolicy(params),
      ),
    );
    this.rpc.handle('deletePolicy', async ({ name, operator }) =>
      this.change(
        operator === true
          ? vscode.l10n.t('Delete the operator policy "{0}"?', name)
          : vscode.l10n.t('Delete the policy "{0}"?', name),
        vscode.l10n.t('Delete'),
        true,
        async () => model.deletePolicy(name, operator === true),
      ),
    );
    this.rpc.handle('setLimit', async ({ limit, value }) =>
      this.change(
        value === undefined
          ? vscode.l10n.t('Lift the limit {0} of the virtual host "{1}"?', limit, model.name)
          : vscode.l10n.t(
              'Set the limit {0} of the virtual host "{1}" to {2}?',
              limit,
              model.name,
              value,
            ),
        value === undefined ? vscode.l10n.t('Lift') : vscode.l10n.t('Set'),
        false,
        async () => model.setLimit(limit, value),
        value === undefined ? undefined : vscode.l10n.t('Clients over the limit are refused.'),
      ),
    );
    this.rpc.handle('setVhostSettings', async (params) =>
      this.change(
        vscode.l10n.t('Change the settings of the virtual host "{0}"?', model.name),
        vscode.l10n.t('Change'),
        false,
        async () => model.setVhostSettings(params),
      ),
    );
    this.rpc.handle('setLive', async ({ on }) => {
      if (!on) {
        model.stopLive();
        this.push(model.state());
        return {};
      }
      await model.startLive(
        (state) => {
          this.push(state);
        },
        (error) => {
          this.log.warn('Reading the queue for the graphs failed', error);
          this.push(model.state());
          void vscode.window.showErrorMessage(
            vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
          );
        },
      );
      return {};
    });
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
    this.deps.model.stopLive();
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

  /**
   * Asks, makes one change and shows the result. A read-only connection skips the question,
   * so the model can refuse with its reason; `always` asks on every connection, otherwise
   * only a production one is asked.
   */
  private async change(
    question: string,
    action: string,
    always: boolean,
    run: () => Promise<RabbitObjectState>,
    detail?: string,
  ): Promise<{ done: boolean }> {
    const policy = this.deps.policy;
    if (!policy.readOnly && (always || changeVerdict(policy) === 'confirm')) {
      const production =
        changeVerdict(policy) === 'confirm'
          ? vscode.l10n.t('"{0}" is a production connection.', policy.name)
          : undefined;
      const answer = await vscode.window.showWarningMessage(
        question,
        {
          modal: true,
          ...(detail === undefined && production === undefined
            ? {}
            : { detail: [production, detail].filter((line) => line !== undefined).join(' ') }),
        },
        action,
      );
      if (answer !== action) {
        return { done: false };
      }
    }
    this.push(await run());
    return { done: true };
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

// The Kafka topic page (V13.23): one panel per topic. It asks before sending a message on
// a production connection, always before deleting the topic, and tells the tree when a
// topic goes.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { changeVerdict, type WritePolicy } from '../../services/write-policy';
import {
  type KafkaTopicProtocol,
  kafkaTopicProtocol,
  type KafkaTopicState,
} from '../../shared/protocols/kafka-topic';
import { RpcPeer } from '../../shared/rpc';
import type { KafkaTopicModel } from './kafka-topic-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export interface KafkaTopicPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly connectionId: string;
  readonly model: KafkaTopicModel;
  readonly policy: WritePolicy;
  /** Called after the topic was deleted, so the tree can follow. */
  readonly onDeleted: (connectionId: string, topic: string) => void;
}

function titleOf(topic: string): string {
  return topic.length > 60 ? `${topic.slice(0, 57)}…` : topic;
}

export class KafkaTopicPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.kafkaTopic';

  private static readonly open = new Map<string, KafkaTopicPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<KafkaTopicProtocol['host'], KafkaTopicProtocol['webview']>;
  private readonly log: Logger;
  private readonly aborts = new Set<AbortController>();
  private state: KafkaTopicState | undefined;
  private disposed = false;

  /** Opens the page of a topic, or brings its open page forward and reads it again. */
  static show(deps: KafkaTopicPanelDeps): KafkaTopicPanel {
    const id = `${deps.connectionId}\u0000${deps.model.topic}`;
    const existing = KafkaTopicPanel.open.get(id);
    if (existing !== undefined && !existing.disposed) {
      existing.panel.reveal();
      void existing.reload();
      return existing;
    }
    const panel = new KafkaTopicPanel(deps);
    KafkaTopicPanel.open.set(id, panel);
    return panel;
  }

  static disposeAll(): void {
    for (const panel of [...KafkaTopicPanel.open.values()]) {
      panel.dispose();
    }
    KafkaTopicPanel.open.clear();
  }

  private constructor(private readonly deps: KafkaTopicPanelDeps) {
    this.log = deps.logger.child('kafka-topic');
    this.panel = createWebviewAppPanel(deps.extensionUri, {
      viewType: KafkaTopicPanel.viewType,
      title: titleOf(deps.model.topic),
      app: 'kafka-topic',
    });
    this.rpc = new RpcPeer({
      local: kafkaTopicProtocol.host,
      remote: kafkaTopicProtocol.webview,
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
    this.rpc.handle('read', async (params) => {
      const abort = new AbortController();
      this.aborts.add(abort);
      try {
        this.push(await model.readMessages(params, abort.signal));
      } finally {
        this.aborts.delete(abort);
      }
      return {};
    });
    this.rpc.handle('tail', async ({ partition, on }) => {
      this.push(
        on
          ? await model.startTail(partition, () => {
              this.push(model.state());
            })
          : model.stopTail(),
      );
      return {};
    });
    this.rpc.handle('produce', async (params) => {
      if (!(await this.allowed(vscode.l10n.t('Send')))) {
        return { produced: false };
      }
      const result = await model.produce({
        ...(params.partition === undefined ? {} : { partition: params.partition }),
        ...(params.key === undefined ? {} : { key: params.key }),
        value: params.value,
        headers: params.headers,
      });
      this.push(result.state);
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Sent to partition {0} at offset {1}', result.partition, result.offset),
      );
      return { produced: true, partition: result.partition, offset: result.offset };
    });
    this.rpc.handle('deleteTopic', async () => ({ deleted: await this.deleteTopic() }));
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
    this.deps.model.stopTail();
    for (const abort of this.aborts) {
      abort.abort();
    }
    for (const [id, panel] of KafkaTopicPanel.open) {
      if (panel === this) {
        KafkaTopicPanel.open.delete(id);
      }
    }
    this.rpc.dispose();
    this.panel.dispose();
  }

  private async reload(): Promise<void> {
    try {
      this.push(await this.deps.model.refresh());
    } catch (error) {
      this.log.warn('Reading the topic failed', error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('DataNest: {0}', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private push(state: KafkaTopicState): void {
    this.state = state;
    if (!this.disposed) {
      this.rpc.emit('state', state);
    }
  }

  /** True once the connection allows the change; production asks every time. */
  private async allowed(action: string): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      // The model refuses with the reason; asking first would be pointless.
      return true;
    }
    if (changeVerdict(this.deps.policy) !== 'confirm') {
      return true;
    }
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Send a message to the topic "{0}" on the production connection "{1}"?',
        this.deps.model.topic,
        this.deps.policy.name,
      ),
      { modal: true },
      action,
    );
    return answer === action;
  }

  private async deleteTopic(): Promise<boolean> {
    if (this.deps.policy.readOnly) {
      await this.deps.model.deleteTopic();
    }
    const remove = vscode.l10n.t('Delete');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete the topic "{0}"?', this.deps.model.topic),
      {
        modal: true,
        detail: vscode.l10n.t('Its messages are lost for good.'),
      },
      remove,
    );
    if (answer !== remove) {
      return false;
    }
    await this.deps.model.deleteTopic();
    this.deps.onDeleted(this.deps.connectionId, this.deps.model.topic);
    this.dispose();
    return true;
  }
}

// A Kafka session handed out by ConnectionManager (V13.23). It behaves like the driver's
// session but tells the manager when the link is gone, so the dead session is dropped and
// the next acquireKafka() opens a fresh one (D26), and it lists the topics after a quiet
// spell (V4.9) to keep the brokers from closing an idle connection.

import { toDbError } from '../../core/errors';
import type {
  KafkaCommitted,
  KafkaGroupInfo,
  KafkaLag,
  KafkaMessage,
  KafkaOffsetTarget,
  KafkaProduced,
  KafkaProduceRequest,
  KafkaReadRequest,
  KafkaServerInfo,
  KafkaSession,
  KafkaTopicDetails,
  KafkaTopicInfo,
  KafkaWatchRequest,
} from '../../drivers/kafka-driver';

export interface ManagedKafkaSessionHooks {
  readonly onLinkLost: (error: unknown) => void;
  readonly onClosed?: () => Promise<void>;
  /** Quiet milliseconds before a ping; 0 or absent: never. */
  readonly keepAliveMs?: number;
}

export class ManagedKafkaSession implements KafkaSession {
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;
  private readonly keepAliveMs: number;
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = 0;
  private closed = false;

  constructor(
    private readonly inner: KafkaSession,
    hooks: ManagedKafkaSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
    this.keepAliveMs = hooks.keepAliveMs ?? 0;
  }

  get server(): KafkaServerInfo {
    return this.inner.server;
  }

  listTopics(): Promise<readonly KafkaTopicInfo[]> {
    return this.call(() => this.inner.listTopics());
  }

  describeTopic(name: string): Promise<KafkaTopicDetails> {
    return this.call(() => this.inner.describeTopic(name));
  }

  readMessages(request: KafkaReadRequest): Promise<readonly KafkaMessage[]> {
    return this.call(() => this.inner.readMessages(request));
  }

  offsetsForTime(topic: string, timestamp: number): Promise<ReadonlyMap<number, string>> {
    return this.call(() => this.inner.offsetsForTime(topic, timestamp));
  }

  watchMessages(
    request: KafkaWatchRequest,
    onMessages: (messages: readonly KafkaMessage[]) => void,
  ): Promise<void> {
    return this.call(() => this.inner.watchMessages(request, onMessages));
  }

  resetGroupOffsets(
    groupId: string,
    topic: string,
    target: KafkaOffsetTarget,
  ): Promise<readonly KafkaCommitted[]> {
    return this.call(() => this.inner.resetGroupOffsets(groupId, topic, target));
  }

  listGroups(): Promise<readonly KafkaGroupInfo[]> {
    return this.call(() => this.inner.listGroups());
  }

  groupLag(groupId: string): Promise<readonly KafkaLag[]> {
    return this.call(() => this.inner.groupLag(groupId));
  }

  produce(request: KafkaProduceRequest): Promise<KafkaProduced> {
    return this.call(() => this.inner.produce(request));
  }

  createTopic(name: string, partitions: number, replication: number): Promise<void> {
    return this.call(() => this.inner.createTopic(name, partitions, replication));
  }

  deleteTopic(name: string): Promise<void> {
    return this.call(() => this.inner.deleteTopic(name));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopKeepAlive();
    try {
      await this.inner.close();
    } finally {
      await this.onClosed();
    }
  }

  /** Arms the keep-alive for the next stretch of quiet; the session starts quiet. */
  scheduleKeepAlive(): void {
    this.stopKeepAlive();
    if (this.keepAliveMs <= 0 || this.closed || this.busy > 0) {
      return;
    }
    this.keepAliveTimer = setTimeout(() => {
      void this.ping();
    }, this.keepAliveMs);
    this.keepAliveTimer.unref();
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    this.busy += 1;
    this.stopKeepAlive();
    try {
      return await run();
    } catch (error) {
      this.report(error);
      throw toDbError(error);
    } finally {
      this.busy -= 1;
      this.scheduleKeepAlive();
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== undefined) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private async ping(): Promise<void> {
    this.keepAliveTimer = undefined;
    if (this.closed || this.busy > 0) {
      return;
    }
    try {
      await this.inner.listTopics();
    } catch (error) {
      this.report(error);
    }
    this.scheduleKeepAlive();
  }

  private report(error: unknown): void {
    if (toDbError(error).code === 'connection-failed') {
      this.onLinkLost(error);
    }
  }
}

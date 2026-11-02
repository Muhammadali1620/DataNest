// A Kafka cluster in memory, shaped like the slice of kafkajs the session uses (V13.23):
// topics with partitions of messages, committed offsets of consumer groups, and a consumer
// that delivers from the offset it was seeked to. It records what the session did, so the
// tests can show that browsing never commits an offset and always disconnects.

import { openKafkaSession } from '../../src/drivers/kafka/session';
import type { KafkaDriver, KafkaSession } from '../../src/drivers/kafka-driver';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';
import type {
  KafkaAdminLike,
  KafkaClientFactory,
  KafkaClientLike,
  KafkaClientOptions,
  KafkaConsumerLike,
  KafkaIncomingMessage,
  KafkaProducerLike,
} from '../../src/drivers/kafka/session';

export interface FakeRecord {
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly timestamp: string;
  readonly headers: Record<string, Buffer | string | (Buffer | string)[]>;
}

interface FakePartition {
  /** Offset of the first stored message (messages before it were deleted). */
  low: number;
  records: FakeRecord[];
  leader: number;
  replicas: number;
  isr: number;
}

/** Error shaped like the ones kafkajs throws. */
export function kafkaJsError(name: string, message: string, extra: object = {}): Error {
  return Object.assign(new Error(message), { name, ...extra });
}

export class FakeKafka {
  readonly topics = new Map<string, FakePartition[]>();
  /** group → topic → partition → committed offset. */
  readonly groups = new Map<string, Map<string, Map<number, string>>>();
  /** group → state. */
  readonly groupStates = new Map<string, string>();
  readonly options: KafkaClientOptions[] = [];
  readonly consumers: FakeConsumer[] = [];
  readonly sent: { topic: string; messages: unknown[] }[] = [];
  readonly adminCalls: string[] = [];
  /** The resets an admin client was asked for. */
  readonly setOffsetCalls: {
    groupId: string;
    topic: string;
    partitions: { partition: number; offset: string }[];
  }[] = [];
  /** Makes the next admin call of this name throw. */
  readonly failures = new Map<string, Error>();
  adminConnected = 0;
  adminDisconnected = 0;
  producerDisconnected = 0;
  brokers = 1;
  /** A cluster that never delivers: a consumer stays quiet. */
  silent = false;
  clusterId = 'fake-cluster';
  /** What createTopics answers for a topic that exists. */
  clock = 1_700_000_000_000;

  addTopic(name: string, partitions: number, replicas = 1): void {
    this.topics.set(
      name,
      Array.from({ length: partitions }, () => ({
        low: 0,
        records: [],
        leader: 1,
        replicas,
        isr: replicas,
      })),
    );
  }

  /** Stores a message and returns its offset. */
  append(
    topic: string,
    partition: number,
    value: string | Buffer | null,
    options: { key?: string | null; at?: number; headers?: FakeRecord['headers'] } = {},
  ): number {
    const parts = this.topics.get(topic);
    const target = parts?.[partition];
    if (target === undefined) {
      throw new Error(`no ${topic}/${partition}`);
    }
    target.records.push({
      key: options.key === undefined || options.key === null ? null : Buffer.from(options.key),
      value: value === null ? null : Buffer.from(value),
      timestamp: String(options.at ?? (this.clock += 1000)),
      headers: options.headers ?? {},
    });
    return target.low + target.records.length - 1;
  }

  /** Deletes the oldest `count` messages of a partition, as retention does. */
  trim(topic: string, partition: number, count: number): void {
    const target = this.topics.get(topic)?.[partition];
    if (target === undefined) {
      throw new Error(`no ${topic}/${partition}`);
    }
    target.records.splice(0, count);
    target.low += count;
  }

  commit(group: string, topic: string, partition: number, offset: number): void {
    const topics = this.groups.get(group) ?? new Map<string, Map<number, string>>();
    const parts = topics.get(topic) ?? new Map<number, string>();
    parts.set(partition, String(offset));
    topics.set(topic, parts);
    this.groups.set(group, topics);
    this.groupStates.set(group, this.groupStates.get(group) ?? 'Stable');
  }

  /** What was committed anywhere, as text, to compare before and after a read. */
  committedSnapshot(): string {
    return JSON.stringify(
      [...this.groups].map(([group, topics]) => [
        group,
        [...topics].map(([topic, parts]) => [topic, [...parts]]),
      ]),
    );
  }

  /** The client factory the session takes. */
  readonly factory: KafkaClientFactory = (options) => {
    this.options.push(options);
    const refusal = this.failures.get('factory');
    if (refusal !== undefined) {
      this.failures.delete('factory');
      return Promise.reject(refusal);
    }
    return Promise.resolve(this.client());
  };

  client(): KafkaClientLike {
    return {
      admin: () => this.admin(),
      producer: () => this.producer(),
      consumer: (options) => {
        const consumer = new FakeConsumer(this, options.groupId);
        this.consumers.push(consumer);
        return consumer;
      },
    };
  }

  private fail(name: string): void {
    this.adminCalls.push(name);
    const failure = this.failures.get(name);
    if (failure !== undefined) {
      this.failures.delete(name);
      throw failure;
    }
  }

  private partitionsOf(topic: string): FakePartition[] {
    const parts = this.topics.get(topic);
    if (parts === undefined) {
      throw kafkaJsError('KafkaJSProtocolError', 'This server does not host this topic-partition', {
        type: 'UNKNOWN_TOPIC_OR_PARTITION',
      });
    }
    return parts;
  }

  private admin(): KafkaAdminLike {
    return {
      connect: () => {
        this.adminConnected += 1;
        this.fail('connect');
        return Promise.resolve();
      },
      disconnect: () => {
        this.adminDisconnected += 1;
        return Promise.resolve();
      },
      listTopics: () => {
        this.fail('listTopics');
        return Promise.resolve([...this.topics.keys()]);
      },
      fetchTopicMetadata: ({ topics }) => {
        this.fail('fetchTopicMetadata');
        return Promise.resolve({
          topics: topics
            .filter((name) => this.topics.has(name))
            .map((name) => ({
              name,
              partitions: this.partitionsOf(name).map((part, index) => ({
                partitionId: index,
                leader: part.leader,
                replicas: Array.from({ length: part.replicas }, (_, i) => i + 1),
                isr: Array.from({ length: part.isr }, (_, i) => i + 1),
              })),
            })),
        });
      },
      fetchTopicOffsets: (topic) => {
        this.fail('fetchTopicOffsets');
        return Promise.resolve(
          this.partitionsOf(topic).map((part, index) => ({
            partition: index,
            offset: String(part.low + part.records.length),
            high: String(part.low + part.records.length),
            low: String(part.low),
          })),
        );
      },
      fetchTopicOffsetsByTimestamp: (topic, timestamp) => {
        this.fail('fetchTopicOffsetsByTimestamp');
        return Promise.resolve(
          this.partitionsOf(topic).map((part, index) => {
            const at = part.records.findIndex((record) => Number(record.timestamp) >= timestamp);
            // Like kafkajs: a moment after the last message answers with the end offset.
            return {
              partition: index,
              offset: String(part.low + (at < 0 ? part.records.length : at)),
            };
          }),
        );
      },
      listGroups: () => {
        this.fail('listGroups');
        return Promise.resolve({
          groups: [...new Set([...this.groups.keys(), ...this.groupStates.keys()])].map(
            (groupId) => ({ groupId, protocolType: 'consumer' }),
          ),
        });
      },
      describeGroups: (ids) => {
        this.fail('describeGroups');
        return Promise.resolve({
          groups: ids.map((groupId) => ({
            groupId,
            state: this.groupStates.get(groupId) ?? 'Empty',
            members: this.groupStates.get(groupId) === 'Stable' ? [{}, {}] : [],
          })),
        });
      },
      fetchOffsets: ({ groupId, topics: only }) => {
        this.fail('fetchOffsets');
        const topics = this.groups.get(groupId) ?? new Map<string, Map<number, string>>();
        return Promise.resolve(
          [...topics]
            .filter(([topic]) => only === undefined || only.includes(topic))
            .map(([topic, parts]) => ({
              topic,
              partitions: [...parts].map(([partition, offset]) => ({ partition, offset })),
            })),
        );
      },
      setOffsets: ({ groupId, topic, partitions }) => {
        this.fail('setOffsets');
        this.partitionsOf(topic);
        this.setOffsetCalls.push({ groupId, topic, partitions });
        for (const one of partitions) {
          this.commit(groupId, topic, one.partition, Number(one.offset));
        }
        return Promise.resolve();
      },
      describeCluster: () => {
        this.fail('describeCluster');
        return Promise.resolve({
          brokers: Array.from({ length: this.brokers }, (_, i) => ({ nodeId: i + 1 })),
          controller: 1,
          clusterId: this.clusterId,
        });
      },
      createTopics: ({ topics }) => {
        this.fail('createTopics');
        const first = topics[0];
        if (first === undefined) {
          return Promise.resolve(false);
        }
        if (this.topics.has(first.topic)) {
          return Promise.resolve(false);
        }
        this.addTopic(first.topic, first.numPartitions, first.replicationFactor);
        return Promise.resolve(true);
      },
      deleteTopics: ({ topics }) => {
        this.fail('deleteTopics');
        for (const name of topics) {
          this.partitionsOf(name);
          this.topics.delete(name);
        }
        return Promise.resolve();
      },
    };
  }

  private producer(): KafkaProducerLike {
    return {
      connect: () => Promise.resolve(),
      disconnect: () => {
        this.producerDisconnected += 1;
        return Promise.resolve();
      },
      send: ({ topic, messages }) => {
        this.fail('send');
        this.sent.push({ topic, messages });
        const parts = this.partitionsOf(topic);
        const first = messages[0];
        if (first === undefined) {
          return Promise.resolve([]);
        }
        const partition = first.partition ?? 0;
        const headers: FakeRecord['headers'] = {};
        for (const [name, value] of Object.entries(first.headers ?? {})) {
          headers[name] = value;
        }
        const part = parts[partition];
        if (part === undefined) {
          return Promise.resolve([{ partition, errorCode: 3 }]);
        }
        const offset = this.append(topic, partition, first.value, {
          key: first.key === null || first.key === undefined ? null : first.key.toString(),
          headers,
        });
        return Promise.resolve([{ partition, baseOffset: String(offset), errorCode: 0 }]);
      },
    };
  }
}

export class FakeConsumer implements KafkaConsumerLike {
  autoCommit: boolean | undefined;
  connected = false;
  disconnected = false;
  subscribed: string | undefined;
  fromBeginning: boolean | undefined;
  seeks: { partition: number; offset: string }[] = [];
  paused: number[] = [];
  /** Commits it tried; a read must make none. */
  commits = 0;
  /** Messages delivered, as `partition:offset`. */
  delivered: string[] = [];
  private handler:
    | ((payload: {
        topic: string;
        partition: number;
        message: KafkaIncomingMessage;
      }) => Promise<void>)
    | undefined;

  constructor(
    private readonly cluster: FakeKafka,
    readonly groupId: string,
  ) {}

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.disconnected = true;
    return Promise.resolve();
  }

  subscribe(options: { topic: string; fromBeginning?: boolean }): Promise<void> {
    if (!this.cluster.topics.has(options.topic)) {
      return Promise.reject(
        kafkaJsError('KafkaJSProtocolError', 'unknown topic', {
          type: 'UNKNOWN_TOPIC_OR_PARTITION',
        }),
      );
    }
    this.subscribed = options.topic;
    this.fromBeginning = options.fromBeginning;
    return Promise.resolve();
  }

  run(options: {
    autoCommit: boolean;
    eachMessage: (payload: {
      topic: string;
      partition: number;
      message: KafkaIncomingMessage;
    }) => Promise<void>;
  }): Promise<void> {
    this.autoCommit = options.autoCommit;
    this.handler = options.eachMessage;
    // Delivery starts a tick later, so the seek and the pause that follow `run` are in time.
    setTimeout(() => {
      void this.deliver();
    }, 0);
    return Promise.resolve();
  }

  seek(options: { topic: string; partition: number; offset: string }): void {
    this.seeks.push({ partition: options.partition, offset: options.offset });
  }

  pause(topics: { topic: string; partitions?: number[] }[]): void {
    for (const one of topics) {
      this.paused.push(...(one.partitions ?? []));
    }
  }

  private gone(): boolean {
    return this.disconnected;
  }

  /** Delivers what is stored, then whatever is appended later, until the consumer goes. */
  private async deliver(): Promise<void> {
    const topic = this.subscribed;
    const handler = this.handler;
    if (this.cluster.silent || topic === undefined || handler === undefined) {
      return;
    }
    const next = new Map<number, number>();
    while (!this.disconnected) {
      let moved = false;
      const parts = this.cluster.topics.get(topic) ?? [];
      for (const [partition, part] of parts.entries()) {
        if (this.paused.includes(partition)) {
          continue;
        }
        if (!next.has(partition)) {
          const seek = this.seeks.find((one) => one.partition === partition);
          next.set(partition, seek === undefined ? part.low : Number(seek.offset));
        }
        for (
          let offset = Math.max(next.get(partition) ?? 0, part.low);
          offset < part.low + part.records.length;
          offset++
        ) {
          if (this.gone()) {
            return;
          }
          next.set(partition, offset + 1);
          const record = part.records[offset - part.low];
          if (record === undefined) {
            continue;
          }
          moved = true;
          this.delivered.push(`${partition}:${offset}`);
          await handler({
            topic,
            partition,
            message: {
              key: record.key,
              value: record.value,
              timestamp: record.timestamp,
              offset: String(offset),
              headers: record.headers,
            },
          });
        }
      }
      if (!moved) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
}

/** A Kafka driver on the in-memory cluster, for the connection manager's tests. */
export class FakeKafkaDriver implements KafkaDriver {
  readonly id = 'kafka' as const;
  readonly configs: ResolvedConnectionConfig[] = [];
  readonly sessions: { session: KafkaSession; closed: boolean }[] = [];
  failure: Error | undefined;

  constructor(readonly cluster: FakeKafka = new FakeKafka()) {}

  async openSession(config: ResolvedConnectionConfig): Promise<KafkaSession> {
    this.configs.push(config);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const real = await openKafkaSession(config, this.cluster.factory);
    const entry = { session: real, closed: false };
    this.sessions.push(entry);
    return new Proxy(real, {
      get: (target, key, receiver) => {
        if (key === 'close') {
          return async () => {
            entry.closed = true;
            await target.close();
          };
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  }
}

// What a Kafka driver offers (V13.23): the few calls the browser needs, in plain values.
// Not a SQL driver (D81). Offsets are 64-bit numbers, so they travel as decimal strings;
// keys and values are bytes, because Kafka does not know what is in them.

import type { ResolvedConnectionConfig } from '../shared/connection';

/** What the cluster said about itself when the session opened. */
export interface KafkaServerInfo {
  /** The id of the cluster; empty when the brokers are too old to tell. */
  readonly clusterId: string;
  readonly brokers: number;
}

export interface KafkaTopicInfo {
  readonly name: string;
  /** Internal topics (`__consumer_offsets`, `_schemas`, …) are hidden unless asked for. */
  readonly internal: boolean;
}

export interface KafkaPartitionInfo {
  readonly partition: number;
  /** The first offset still stored. */
  readonly low: string;
  /** The offset the next message will get. */
  readonly high: string;
  /** The broker leading the partition; -1 when it has no leader. */
  readonly leader: number;
  readonly replicas: number;
  /** Replicas that are in sync. */
  readonly inSync: number;
}

export interface KafkaTopicDetails {
  readonly name: string;
  readonly partitions: readonly KafkaPartitionInfo[];
}

export interface KafkaHeader {
  readonly name: string;
  readonly value: Uint8Array;
}

export interface KafkaMessage {
  readonly partition: number;
  readonly offset: string;
  /** Milliseconds since the epoch, as a decimal string. */
  readonly timestamp: string;
  readonly key: Uint8Array | null;
  /** Null for a tombstone. */
  readonly value: Uint8Array | null;
  readonly headers: readonly KafkaHeader[];
}

export interface KafkaReadRequest {
  readonly topic: string;
  readonly partition: number;
  /** Where to start. Absent: the last `count` messages. */
  readonly fromOffset?: string;
  readonly count: number;
  /** Stops reading once the messages together hold this many bytes. */
  readonly maxBytes: number;
  /** Milliseconds to wait for the broker in all; the messages read so far are returned. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface KafkaGroupInfo {
  readonly id: string;
  /** `Stable`, `Empty`, `PreparingRebalance`, … */
  readonly state: string;
  readonly members: number;
}

export interface KafkaLag {
  readonly topic: string;
  readonly partition: number;
  /** The offset the group has committed; empty when it has none. */
  readonly committed: string;
  readonly high: string;
  /** Messages the group has not read: `high - committed`. */
  readonly lag: string;
}

export interface KafkaProduceRequest {
  readonly topic: string;
  /** Absent: the cluster picks one (by the key's hash, else round robin). */
  readonly partition?: number;
  readonly key?: Uint8Array;
  readonly value: Uint8Array | null;
  readonly headers?: readonly KafkaHeader[];
}

export interface KafkaProduced {
  readonly partition: number;
  readonly offset: string;
}

/** One live connection to the brokers. */
export interface KafkaSession {
  readonly server: KafkaServerInfo;
  listTopics(): Promise<readonly KafkaTopicInfo[]>;
  describeTopic(name: string): Promise<KafkaTopicDetails>;
  /**
   * Reads messages of one partition. It joins no group of the user's and commits no
   * offset, so browsing never moves what another consumer has read (D153).
   */
  readMessages(request: KafkaReadRequest): Promise<readonly KafkaMessage[]>;
  /**
   * The offset of the first message at or after `timestamp` (ms), per partition. A moment
   * after the last message gives the end offset, the one the next message will get.
   */
  offsetsForTime(topic: string, timestamp: number): Promise<ReadonlyMap<number, string>>;
  listGroups(): Promise<readonly KafkaGroupInfo[]>;
  groupLag(groupId: string): Promise<readonly KafkaLag[]>;
  produce(request: KafkaProduceRequest): Promise<KafkaProduced>;
  createTopic(name: string, partitions: number, replication: number): Promise<void>;
  deleteTopic(name: string): Promise<void>;
  close(): Promise<void>;
}

export interface KafkaDriver {
  readonly id: 'kafka';
  openSession(config: ResolvedConnectionConfig): Promise<KafkaSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/kafka.js. */
export interface KafkaDriverModule {
  readonly driver: KafkaDriver;
}

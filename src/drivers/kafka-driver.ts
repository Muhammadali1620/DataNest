// What a Kafka driver offers (V13.23): the few calls the browser needs, in plain values.
// Not a SQL driver (D81). Offsets are 64-bit numbers, so they travel as decimal strings;
// keys and values are bytes, because Kafka does not know what is in them.

import type { ResolvedConnectionConfig } from '../shared/connection';

/** What the registry's own sign-in adds to a resolved config; a secret of its own (V13.41). */
export interface ResolvedKafkaConfig extends ResolvedConnectionConfig {
  readonly registrySecret?: string;
}

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
  /**
   * Set when `key` or `value` was written with a registry schema and shows decoded (V13.34):
   * the schema's id and format.
   */
  readonly schema?: { readonly id: number; readonly format: 'AVRO' | 'PROTOBUF' | 'JSON' };
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

/** Follows new messages of one partition until `signal` aborts (V13.29). */
export interface KafkaWatchRequest {
  readonly topic: string;
  readonly partition: number;
  /** Where to start. Absent: the end of the partition, so only messages that arrive later. */
  readonly fromOffset?: string;
  readonly signal: AbortSignal;
}

/** Where a group's committed offsets go when they are reset (V13.29). */
export type KafkaOffsetTarget =
  | { readonly kind: 'earliest' }
  | { readonly kind: 'latest' }
  /** One offset for every partition, held inside what the partition stores. */
  | { readonly kind: 'offset'; readonly offset: string }
  /** The first message at or after a moment (ms); past the last message: the end. */
  | { readonly kind: 'time'; readonly timestamp: number };

/** What a reset committed for one partition. */
export interface KafkaCommitted {
  readonly partition: number;
  /** The offset the group had before; empty when it had none. */
  readonly before: string;
  readonly offset: string;
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

/** What an ACL applies to (V13.34). */
export const KAFKA_ACL_RESOURCES = ['topic', 'group', 'cluster', 'transactionalId'] as const;
export type KafkaAclResource = (typeof KAFKA_ACL_RESOURCES)[number];

/** `literal`: the name itself; `prefixed`: every name that starts with it. */
export const KAFKA_ACL_PATTERNS = ['literal', 'prefixed'] as const;
export type KafkaAclPattern = (typeof KAFKA_ACL_PATTERNS)[number];

export const KAFKA_ACL_OPERATIONS = [
  'all',
  'read',
  'write',
  'create',
  'delete',
  'alter',
  'describe',
  'clusterAction',
  'describeConfigs',
  'alterConfigs',
  'idempotentWrite',
] as const;
export type KafkaAclOperation = (typeof KAFKA_ACL_OPERATIONS)[number];

/** One access rule of the cluster: who may (or may not) do what to which resource. */
export interface KafkaAcl {
  readonly resource: KafkaAclResource;
  /** `kafka-cluster` for the cluster. */
  readonly name: string;
  readonly pattern: KafkaAclPattern;
  /** `User:alice`; `User:*` stands for everybody. */
  readonly principal: string;
  /** `*` for any address. */
  readonly host: string;
  readonly operation: KafkaAclOperation;
  readonly permission: 'allow' | 'deny';
}

/** What a setting belongs to: a topic, or a broker (by its id). */
export type KafkaConfigTarget =
  | { readonly kind: 'topic'; readonly name: string }
  | { readonly kind: 'broker'; readonly id: number };

/** One setting of a topic or a broker (V13.34). */
export interface KafkaConfigEntry {
  readonly name: string;
  /** Empty for a sensitive setting: the broker never tells it. */
  readonly value: string;
  /** Set on the topic or the broker itself, not inherited and not the default. */
  readonly overridden: boolean;
  readonly sensitive: boolean;
  readonly readOnly: boolean;
  /** Where the value comes from, in words (`topic`, `dynamic broker`, `static`, `default`). */
  readonly source: string;
}

/** One broker of the cluster. */
export interface KafkaBrokerInfo {
  readonly id: number;
  readonly host: string;
  readonly port: number;
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
  /**
   * Follows a partition live: `onMessages` gets every message that arrives, in order, until
   * the signal aborts (then this resolves). Like a read it uses a throw-away group and
   * commits nothing (D153).
   */
  watchMessages(
    request: KafkaWatchRequest,
    onMessages: (messages: readonly KafkaMessage[]) => void,
  ): Promise<void>;
  listGroups(): Promise<readonly KafkaGroupInfo[]>;
  /**
   * Commits new offsets for a group on every partition of a topic. The group must have no
   * live members: the broker would refuse otherwise, and the consumers would overwrite it.
   */
  resetGroupOffsets(
    groupId: string,
    topic: string,
    target: KafkaOffsetTarget,
  ): Promise<readonly KafkaCommitted[]>;
  groupLag(groupId: string): Promise<readonly KafkaLag[]>;
  produce(request: KafkaProduceRequest): Promise<KafkaProduced>;
  createTopic(name: string, partitions: number, replication: number): Promise<void>;
  deleteTopic(name: string): Promise<void>;
  /** The brokers of the cluster. */
  listBrokers(): Promise<readonly KafkaBrokerInfo[]>;
  /** The access rules of the cluster; an error says so when no authorizer is on. */
  listAcls(): Promise<readonly KafkaAcl[]>;
  createAcl(acl: KafkaAcl): Promise<void>;
  /** Removes the rules that match `acl` exactly; returns how many there were. */
  deleteAcl(acl: KafkaAcl): Promise<number>;
  /** All settings of a topic or a broker, overridden ones marked. */
  describeConfig(target: KafkaConfigTarget): Promise<readonly KafkaConfigEntry[]>;
  /**
   * Sets one setting, or takes its override away when `value` is null. The older call that
   * kafkajs offers replaces everything set on the resource, so the session sends the
   * overrides that exist now along with the change; nothing else is lost.
   */
  setConfig(target: KafkaConfigTarget, name: string, value: string | null): Promise<void>;
  close(): Promise<void>;
}

export interface KafkaDriver {
  readonly id: 'kafka';
  openSession(config: ResolvedKafkaConfig): Promise<KafkaSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/kafka.js. */
export interface KafkaDriverModule {
  readonly driver: KafkaDriver;
}

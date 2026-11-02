// A Kafka session over kafkajs (V13.23). The client is reached through the small `Kafka*`
// shapes below, so the rest of the app (and the tests) never see kafkajs itself.
//
// Browsing must not disturb anybody. kafkajs can only read through a consumer group, so a
// read joins a group of its own with a throw-away name (`datanest-peek-<random>`), turns
// auto-commit off and never commits: no group of the user's is joined and none of its
// offsets moves (D153). The throw-away group is empty and without offsets once the read
// ends, so the broker forgets it; the group list hides the name meanwhile.

import { randomUUID } from 'node:crypto';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { identityCheck, sniName, tlsFailure, tlsMaterial, type TlsMaterial } from '../common/tls';
import type {
  KafkaAcl,
  KafkaAclOperation,
  KafkaAclPattern,
  KafkaAclResource,
  KafkaBrokerInfo,
  KafkaCommitted,
  KafkaConfigEntry,
  KafkaConfigTarget,
  KafkaGroupInfo,
  KafkaHeader,
  KafkaLag,
  KafkaMessage,
  KafkaOffsetTarget,
  KafkaPartitionInfo,
  KafkaProduced,
  KafkaProduceRequest,
  KafkaReadRequest,
  KafkaServerInfo,
  KafkaSession,
  KafkaTopicDetails,
  KafkaTopicInfo,
  KafkaWatchRequest,
} from '../kafka-driver';
import { kafkaFailure } from './errors';
import { basicAuth, globalRegistryFetch, type RegistryFetch, SchemaRegistry } from './registry';

const ACL_ANY = 1;
const ACL_ALLOW = 3;
const ACL_DENY = 2;
const ACL_RESOURCES: Readonly<Record<KafkaAclResource, number>> = {
  topic: 2,
  group: 3,
  cluster: 4,
  transactionalId: 5,
};
const ACL_PATTERNS: Readonly<Record<KafkaAclPattern, number>> = { literal: 3, prefixed: 4 };
const ACL_OPERATIONS: Readonly<Record<KafkaAclOperation, number>> = {
  all: 2,
  read: 3,
  write: 4,
  create: 5,
  delete: 6,
  alter: 7,
  describe: 8,
  clusterAction: 9,
  describeConfigs: 10,
  alterConfigs: 11,
  idempotentWrite: 12,
};
const CONFIG_SHOW_TRIES = 20;
const CONFIG_SHOW_WAIT_MS = 250;
const CONFIG_TOPIC = 1;
const CONFIG_DYNAMIC = 2;
const CONFIG_SOURCES: Readonly<Record<number, string>> = {
  1: 'topic',
  2: 'dynamic broker',
  3: 'dynamic cluster default',
  4: 'static',
  5: 'default',
  6: 'dynamic logger',
};

function nameOf<K extends string>(table: Readonly<Record<K, number>>, code: number): K | undefined {
  return (Object.keys(table) as K[]).find((key) => table[key] === code);
}

function aclEntryOf(acl: KafkaAcl): KafkaAclEntry {
  return {
    resourceType: ACL_RESOURCES[acl.resource],
    resourceName: acl.name,
    resourcePatternType: ACL_PATTERNS[acl.pattern],
    principal: acl.principal,
    host: acl.host,
    operation: ACL_OPERATIONS[acl.operation],
    permissionType: acl.permission === 'allow' ? ACL_ALLOW : ACL_DENY,
  };
}

function configResource(target: KafkaConfigTarget): { type: number; name: string } {
  return target.kind === 'topic'
    ? { type: 2, name: target.name }
    : { type: 4, name: String(target.id) };
}

/** The name every read-only peek group starts with; the group list leaves these out. */
export const PEEK_GROUP_PREFIX = 'datanest-peek-';

/** Milliseconds a read waits for the brokers at most when the caller gives no limit. */
export const DEFAULT_READ_TIMEOUT_MS = 20_000;

/** The slice of kafkajs' admin client the session uses. */
/** An ACL as kafkajs wants it: its parts are numbers (`ACL_*` below). */
export interface KafkaAclEntry {
  resourceType: number;
  resourceName: string;
  resourcePatternType: number;
  principal: string;
  host: string;
  operation: number;
  permissionType: number;
}

export type KafkaAclFilter = Omit<KafkaAclEntry, 'principal' | 'host' | 'resourceName'> & {
  principal?: string;
  host?: string;
  resourceName?: string;
};

export interface KafkaAdminLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTopics(): Promise<string[]>;
  fetchTopicMetadata(options: { topics: string[] }): Promise<{
    topics: {
      name: string;
      partitions: { partitionId: number; leader: number; replicas: number[]; isr: number[] }[];
    }[];
  }>;
  fetchTopicOffsets(
    topic: string,
  ): Promise<{ partition: number; offset: string; high: string; low: string }[]>;
  fetchTopicOffsetsByTimestamp(
    topic: string,
    timestamp: number,
  ): Promise<{ partition: number; offset: string }[]>;
  listGroups(): Promise<{ groups: { groupId: string; protocolType: string }[] }>;
  describeGroups(
    groupIds: string[],
  ): Promise<{ groups: { groupId: string; state: string; members: unknown[] }[] }>;
  fetchOffsets(options: {
    groupId: string;
    topics?: string[];
  }): Promise<{ topic: string; partitions: { partition: number; offset: string }[] }[]>;
  describeCluster(): Promise<{
    brokers: { nodeId: number; host: string; port: number }[];
    controller: number | null;
    clusterId: string;
  }>;
  describeAcls(filter: KafkaAclFilter): Promise<{
    errorCode: number;
    errorMessage?: string;
    resources: {
      resourceType: number;
      resourceName: string;
      resourcePatternType: number;
      acls: { principal: string; host: string; operation: number; permissionType: number }[];
    }[];
  }>;
  createAcls(options: { acl: KafkaAclEntry[] }): Promise<boolean>;
  deleteAcls(options: { filters: KafkaAclFilter[] }): Promise<{
    filterResponses: { errorCode: number; errorMessage?: string; matchingAcls: unknown[] }[];
  }>;
  describeConfigs(options: {
    resources: { type: number; name: string }[];
    includeSynonyms: boolean;
  }): Promise<{
    resources: {
      resourceName: string;
      errorCode: number;
      errorMessage: string;
      configEntries: {
        configName: string;
        configValue: string | null;
        configSource: number;
        isSensitive: boolean;
        readOnly: boolean;
      }[];
    }[];
  }>;
  alterConfigs(options: {
    validateOnly: boolean;
    resources: { type: number; name: string; configEntries: { name: string; value: string }[] }[];
  }): Promise<unknown>;
  createTopics(options: {
    topics: { topic: string; numPartitions: number; replicationFactor: number }[];
    waitForLeaders?: boolean;
  }): Promise<boolean>;
  deleteTopics(options: { topics: string[] }): Promise<void>;
  setOffsets(options: {
    groupId: string;
    topic: string;
    partitions: { partition: number; offset: string }[];
  }): Promise<void>;
}

export interface KafkaIncomingMessage {
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly timestamp: string;
  readonly offset: string;
  readonly headers?: Readonly<
    Record<string, Buffer | string | (Buffer | string)[] | undefined> | undefined
  >;
}

/** The slice of kafkajs' consumer the session uses. */
export interface KafkaConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(options: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(options: {
    autoCommit: boolean;
    eachMessage: (payload: {
      topic: string;
      partition: number;
      message: KafkaIncomingMessage;
    }) => Promise<void>;
  }): Promise<void>;
  seek(options: { topic: string; partition: number; offset: string }): void;
  pause(topics: { topic: string; partitions?: number[] }[]): void;
}

/** The slice of kafkajs' producer the session uses. */
export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: {
    topic: string;
    acks?: number;
    messages: {
      key?: Buffer | null;
      value: Buffer | null;
      partition?: number;
      headers?: Record<string, Buffer | (Buffer | string)[]>;
    }[];
  }): Promise<{ partition: number; baseOffset?: string; offset?: string; errorCode: number }[]>;
}

export interface KafkaClientLike {
  admin(): KafkaAdminLike;
  producer(options?: { allowAutoTopicCreation?: boolean }): KafkaProducerLike;
  consumer(options: {
    groupId: string;
    allowAutoTopicCreation?: boolean;
    maxWaitTimeInMs?: number;
  }): KafkaConsumerLike;
}

/** What the factory is asked to build a client from. */
export interface KafkaClientOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
  readonly ssl?: Readonly<Record<string, unknown>>;
  readonly sasl?: {
    readonly mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    readonly username: string;
    readonly password: string;
  };
}

export type KafkaClientFactory = (options: KafkaClientOptions) => Promise<KafkaClientLike>;

/** Builds the real client; kafkajs is loaded here, in the driver's own bundle. */
export const kafkajsFactory: KafkaClientFactory = async (options) => {
  const { Kafka, logLevel } = await import('kafkajs');
  const config = {
    clientId: options.clientId,
    brokers: [...options.brokers],
    connectionTimeout: options.connectionTimeout,
    requestTimeout: options.requestTimeout,
    // A few retries: a new topic needs a moment before its leaders are known, and a wrong address should still fail in seconds.
    retry: { retries: 4, initialRetryTime: 300, maxRetryTime: 3000 },
    logLevel: logLevel.NOTHING,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    ...(options.sasl === undefined ? {} : { sasl: options.sasl }),
  };
  return new Kafka(config as ConstructorParameters<typeof Kafka>[0]);
};

/** `a:9092,b` → `['a:9092', 'b:<port>']`; blanks and repeats go. */
export function brokersOf(host: string | undefined, port: number | undefined): string[] {
  const fallback = port ?? DEFAULT_PORTS.kafka ?? 9092;
  const seen = new Set<string>();
  for (const part of (host ?? 'localhost').split(',')) {
    const name = part.trim();
    if (name === '') {
      continue;
    }
    // `[::1]` and `[::1]:9093` are IPv6; a bare `host` takes the port box's value.
    const hasPort = /^\[.*\]:\d+$/u.test(name) || (!name.startsWith('[') && /:\d+$/u.test(name));
    seen.add(hasPort ? name : `${name}:${fallback}`);
  }
  return seen.size === 0 ? [`localhost:${fallback}`] : [...seen];
}

export function isInternalTopic(name: string): boolean {
  return name.startsWith('_');
}

function tlsOptions(tls: TlsMaterial | undefined): Record<string, unknown> | undefined {
  if (tls === undefined) {
    return undefined;
  }
  const servername = sniName(tls.serverName);
  return {
    ...(tls.ca === undefined ? {} : { ca: [tls.ca] }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    rejectUnauthorized: tls.mode !== 'require',
    checkServerIdentity: identityCheck(tls),
    ...(servername === undefined ? {} : { servername }),
  };
}

/** What the client needs to know of a connection. */
export function clientOptionsOf(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): KafkaClientOptions {
  const mechanism = config.kafka?.sasl ?? 'none';
  const ssl = tlsOptions(tls);
  return {
    brokers: brokersOf(config.host, config.port),
    clientId: 'datanest',
    connectionTimeout: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
    requestTimeout: 30_000,
    ...(ssl === undefined ? {} : { ssl }),
    ...(mechanism === 'none'
      ? {}
      : {
          sasl: {
            mechanism,
            username: config.user?.trim() ?? '',
            password: config.password ?? '',
          },
        }),
  };
}

function headerBytes(value: Buffer | string | (Buffer | string)[] | undefined): Uint8Array[] {
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).map((one) =>
    typeof one === 'string' ? Buffer.from(one, 'utf8') : one,
  );
}

/** A message as the app sees it; a header sent twice shows up twice. */
export function messageOf(partition: number, message: KafkaIncomingMessage): KafkaMessage {
  const headers: KafkaHeader[] = [];
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    for (const one of headerBytes(value)) {
      headers.push({ name, value: one });
    }
  }
  return {
    partition,
    offset: message.offset,
    timestamp: message.timestamp,
    key: message.key,
    value: message.value,
    headers,
  };
}

function bigintOf(text: string | undefined, fallback: bigint): bigint {
  if (text === undefined || !/^-?\d+$/u.test(text)) {
    return fallback;
  }
  return BigInt(text);
}

class ClientSession implements KafkaSession {
  server: KafkaServerInfo = { clusterId: '', brokers: 0 };
  private producer: KafkaProducerLike | undefined;
  private producerOpening: Promise<KafkaProducerLike> | undefined;
  private closed = false;

  constructor(
    private readonly client: KafkaClientLike,
    private admin: KafkaAdminLike,
    private readonly registry?: SchemaRegistry,
  ) {}

  /** Shows a message written with a registry schema decoded; any other stays as it is. */
  private async decoded(message: KafkaMessage): Promise<KafkaMessage> {
    if (this.registry === undefined) {
      return message;
    }
    const value = message.value === null ? undefined : await this.registry.decode(message.value);
    const key = message.key === null ? undefined : await this.registry.decode(message.key);
    if (value === undefined && key === undefined) {
      return message;
    }
    const shown = value ?? key;
    return {
      ...message,
      key: key === undefined ? message.key : key.bytes,
      value: value === undefined ? message.value : value.bytes,
      ...(shown === undefined ? {} : { schema: { id: shown.id, format: shown.format } }),
    };
  }

  async open(): Promise<void> {
    await this.admin.connect();
    const cluster = await this.admin.describeCluster();
    this.server = { clusterId: cluster.clusterId, brokers: cluster.brokers.length };
  }

  async listTopics(): Promise<readonly KafkaTopicInfo[]> {
    const names = await this.run(() => this.admin.listTopics());
    return names
      .map((name) => ({ name, internal: isInternalTopic(name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTopic(name: string): Promise<KafkaTopicDetails> {
    const [meta, offsets] = await this.run(async () =>
      Promise.all([
        this.admin.fetchTopicMetadata({ topics: [name] }),
        this.admin.fetchTopicOffsets(name),
      ]),
    );
    const topic = meta.topics.find((one) => one.name === name);
    if (topic === undefined) {
      throw new DbError('not-found', msg('The topic "{0}" does not exist', name));
    }
    const partitions: KafkaPartitionInfo[] = topic.partitions
      .map((one) => {
        const range = offsets.find((o) => o.partition === one.partitionId);
        return {
          partition: one.partitionId,
          low: range?.low ?? '0',
          high: range?.high ?? '0',
          leader: one.leader,
          replicas: one.replicas.length,
          inSync: one.isr.length,
        };
      })
      .sort((a, b) => a.partition - b.partition);
    return { name, partitions };
  }

  async readMessages(request: KafkaReadRequest): Promise<readonly KafkaMessage[]> {
    const offsets = await this.run(() => this.admin.fetchTopicOffsets(request.topic));
    const range = offsets.find((one) => one.partition === request.partition);
    if (range === undefined) {
      throw new DbError(
        'not-found',
        msg('The topic "{0}" has no partition {1}', request.topic, request.partition),
      );
    }
    const low = BigInt(range.low);
    const high = BigInt(range.high);
    const wanted = BigInt(Math.max(1, request.count));
    let start =
      request.fromOffset === undefined ? high - wanted : bigintOf(request.fromOffset, low);
    start = start < low ? low : start > high ? high : start;
    if (start >= high) {
      return [];
    }
    return await this.consume(request, start, high, offsets);
  }

  /** Reads `[start, end)` of one partition through a consumer that commits nothing. */
  private async consume(
    request: KafkaReadRequest,
    start: bigint,
    end: bigint,
    offsets: readonly { partition: number }[],
  ): Promise<readonly KafkaMessage[]> {
    const consumer = this.client.consumer({
      groupId: `${PEEK_GROUP_PREFIX}${randomUUID()}`,
      allowAutoTopicCreation: false,
      maxWaitTimeInMs: 500,
    });
    const messages: KafkaMessage[] = [];
    let bytes = 0;
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(finish, request.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
    const onAbort = (): void => {
      finish();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted === true) {
      finish();
    }
    try {
      await this.run(async () => {
        await consumer.connect();
        await consumer.subscribe({ topic: request.topic, fromBeginning: true });
        await consumer.run({
          autoCommit: false,
          eachMessage: async ({ partition, message }) => {
            if (partition !== request.partition) {
              return;
            }
            const offset = BigInt(message.offset);
            if (offset < start || messages.length >= request.count) {
              return;
            }
            messages.push(await this.decoded(messageOf(partition, message)));
            bytes += (message.key?.length ?? 0) + (message.value?.length ?? 0);
            if (
              messages.length >= request.count ||
              offset + 1n >= end ||
              bytes >= request.maxBytes
            ) {
              finish();
            }
          },
        });
        consumer.seek({
          topic: request.topic,
          partition: request.partition,
          offset: start.toString(),
        });
        const others = offsets.map((one) => one.partition).filter((p) => p !== request.partition);
        if (others.length > 0) {
          consumer.pause([{ topic: request.topic, partitions: others }]);
        }
      });
      await finished;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      await consumer.disconnect().catch(() => undefined);
    }
    return messages.sort((a, b) => Number(BigInt(a.offset) - BigInt(b.offset)));
  }

  async watchMessages(
    request: KafkaWatchRequest,
    onMessages: (messages: readonly KafkaMessage[]) => void,
  ): Promise<void> {
    const offsets = await this.run(() => this.admin.fetchTopicOffsets(request.topic));
    const range = offsets.find((one) => one.partition === request.partition);
    if (range === undefined) {
      throw new DbError(
        'not-found',
        msg('The topic "{0}" has no partition {1}', request.topic, request.partition),
      );
    }
    const low = BigInt(range.low);
    const high = BigInt(range.high);
    let start = bigintOf(request.fromOffset, high);
    start = start < low ? low : start > high ? high : start;
    const consumer = this.client.consumer({
      groupId: `${PEEK_GROUP_PREFIX}${randomUUID()}`,
      allowAutoTopicCreation: false,
      maxWaitTimeInMs: 500,
    });
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stopped = (): boolean => request.signal.aborted;
    const onAbort = (): void => {
      finish();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) {
      finish();
    }
    try {
      await this.run(async () => {
        await consumer.connect();
        await consumer.subscribe({ topic: request.topic, fromBeginning: true });
        await consumer.run({
          autoCommit: false,
          eachMessage: async ({ partition, message }) => {
            if (
              partition === request.partition &&
              !request.signal.aborted &&
              BigInt(message.offset) >= start
            ) {
              const shown = await this.decoded(messageOf(partition, message));
              if (!stopped()) {
                onMessages([shown]);
              }
            }
          },
        });
        consumer.seek({
          topic: request.topic,
          partition: request.partition,
          offset: start.toString(),
        });
        const others = offsets.map((one) => one.partition).filter((p) => p !== request.partition);
        if (others.length > 0) {
          consumer.pause([{ topic: request.topic, partitions: others }]);
        }
      });
      await finished;
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      await consumer.disconnect().catch(() => undefined);
    }
  }

  async resetGroupOffsets(
    groupId: string,
    topic: string,
    target: KafkaOffsetTarget,
  ): Promise<readonly KafkaCommitted[]> {
    const [described, ranges, before] = await this.run(async () =>
      Promise.all([
        this.admin.describeGroups([groupId]),
        this.admin.fetchTopicOffsets(topic),
        this.admin.fetchOffsets({ groupId, topics: [topic] }),
      ]),
    );
    const state = described.groups.find((one) => one.groupId === groupId)?.state;
    if (state === undefined || state === 'Dead') {
      throw new DbError('not-found', msg('The consumer group "{0}" does not exist', groupId));
    }
    if (state !== 'Empty') {
      // Members commit on their own: a reset under them is lost, or the broker refuses it.
      throw new DbError(
        'constraint',
        msg('The group "{0}" is running ({1}); stop its consumers first', groupId, state),
        { driverCode: 'NON_EMPTY_GROUP' },
      );
    }
    if (ranges.length === 0) {
      throw new DbError('not-found', msg('The topic "{0}" has no partitions', topic));
    }
    const moments =
      target.kind === 'time'
        ? await this.offsetsForTime(topic, target.timestamp)
        : new Map<number, string>();
    const was = new Map(
      (before.find((one) => one.topic === topic)?.partitions ?? []).map((one) => [
        one.partition,
        /^\d+$/u.test(one.offset) ? one.offset : '',
      ]),
    );
    const commits: KafkaCommitted[] = ranges
      .map((range) => {
        const low = BigInt(range.low);
        const high = BigInt(range.high);
        let offset: bigint;
        switch (target.kind) {
          case 'earliest':
            offset = low;
            break;
          case 'latest':
            offset = high;
            break;
          case 'offset':
            offset = bigintOf(target.offset, low);
            break;
          case 'time':
            offset = bigintOf(moments.get(range.partition), high);
            break;
        }
        offset = offset < low ? low : offset > high ? high : offset;
        return {
          partition: range.partition,
          before: was.get(range.partition) ?? '',
          offset: offset.toString(),
        };
      })
      .sort((a, b) => a.partition - b.partition);
    await this.run(() =>
      this.admin.setOffsets({
        groupId,
        topic,
        partitions: commits.map((one) => ({ partition: one.partition, offset: one.offset })),
      }),
    );
    return commits;
  }

  async offsetsForTime(topic: string, timestamp: number): Promise<ReadonlyMap<number, string>> {
    const found = await this.run(() => this.admin.fetchTopicOffsetsByTimestamp(topic, timestamp));
    return new Map(found.map((one) => [one.partition, one.offset]));
  }

  async listGroups(): Promise<readonly KafkaGroupInfo[]> {
    const listed = await this.run(() => this.admin.listGroups());
    const ids = listed.groups
      .map((one) => one.groupId)
      .filter((id) => !id.startsWith(PEEK_GROUP_PREFIX));
    if (ids.length === 0) {
      return [];
    }
    const described = await this.run(() => this.admin.describeGroups(ids));
    return described.groups
      .map((one) => ({ id: one.groupId, state: one.state, members: one.members.length }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async groupLag(groupId: string): Promise<readonly KafkaLag[]> {
    const committed = await this.run(() => this.admin.fetchOffsets({ groupId }));
    const lags: KafkaLag[] = [];
    for (const topic of committed) {
      const ends = await this.run(() => this.admin.fetchTopicOffsets(topic.topic));
      for (const one of topic.partitions) {
        const range = ends.find((end) => end.partition === one.partition);
        const high = BigInt(range?.high ?? '0');
        const low = BigInt(range?.low ?? '0');
        // -1 is "nothing committed": the group would start at the beginning.
        const has = /^\d+$/u.test(one.offset);
        const lag = has ? high - BigInt(one.offset) : high - low;
        lags.push({
          topic: topic.topic,
          partition: one.partition,
          committed: has ? one.offset : '',
          high: high.toString(),
          lag: (lag < 0n ? 0n : lag).toString(),
        });
      }
    }
    return lags.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
  }

  async produce(request: KafkaProduceRequest): Promise<KafkaProduced> {
    const producer = await this.openProducer();
    const headers: Record<string, Buffer | (Buffer | string)[]> = {};
    for (const header of request.headers ?? []) {
      const value = Buffer.from(header.value);
      const before = headers[header.name];
      headers[header.name] =
        before === undefined ? value : Array.isArray(before) ? [...before, value] : [before, value];
    }
    const sent = await this.run(() =>
      producer.send({
        topic: request.topic,
        acks: -1,
        messages: [
          {
            key: request.key === undefined ? null : Buffer.from(request.key),
            value: request.value === null ? null : Buffer.from(request.value),
            ...(request.partition === undefined ? {} : { partition: request.partition }),
            headers,
          },
        ],
      }),
    );
    const first = sent[0];
    if (first?.errorCode !== 0) {
      throw new DbError('internal', msg('The broker did not accept the message'));
    }
    return { partition: first.partition, offset: first.baseOffset ?? first.offset ?? '0' };
  }

  async createTopic(name: string, partitions: number, replication: number): Promise<void> {
    const created = await this.run(() =>
      this.admin.createTopics({
        topics: [{ topic: name, numPartitions: partitions, replicationFactor: replication }],
        waitForLeaders: true,
      }),
    );
    if (!created) {
      throw new DbError('constraint', msg('The topic "{0}" already exists', name), {
        driverCode: 'TOPIC_ALREADY_EXISTS',
      });
    }
  }

  async deleteTopic(name: string): Promise<void> {
    await this.run(() => this.admin.deleteTopics({ topics: [name] }));
    await this.freshAdmin();
  }

  async listBrokers(): Promise<readonly KafkaBrokerInfo[]> {
    const cluster = await this.run(() => this.admin.describeCluster());
    return cluster.brokers
      .map((one) => ({ id: one.nodeId, host: one.host, port: one.port }))
      .sort((a, b) => a.id - b.id);
  }

  async listAcls(): Promise<readonly KafkaAcl[]> {
    const response = await this.run(() =>
      this.admin.describeAcls({
        resourceType: ACL_ANY,
        resourcePatternType: ACL_ANY,
        operation: ACL_ANY,
        permissionType: ACL_ANY,
      }),
    );
    const found: KafkaAcl[] = [];
    for (const resource of response.resources) {
      const kind = nameOf(ACL_RESOURCES, resource.resourceType);
      const pattern = nameOf(ACL_PATTERNS, resource.resourcePatternType);
      if (kind === undefined || pattern === undefined) {
        continue;
      }
      for (const acl of resource.acls) {
        const operation = nameOf(ACL_OPERATIONS, acl.operation);
        const permission = acl.permissionType === ACL_ALLOW ? 'allow' : 'deny';
        if (operation !== undefined) {
          found.push({
            resource: kind,
            name: resource.resourceName,
            pattern,
            principal: acl.principal,
            host: acl.host,
            operation,
            permission,
          });
        }
      }
    }
    return found.sort((a, b) =>
      `${a.resource}/${a.name}/${a.principal}/${a.operation}`.localeCompare(
        `${b.resource}/${b.name}/${b.principal}/${b.operation}`,
      ),
    );
  }

  async createAcl(acl: KafkaAcl): Promise<void> {
    await this.run(() => this.admin.createAcls({ acl: [aclEntryOf(acl)] }));
  }

  async deleteAcl(acl: KafkaAcl): Promise<number> {
    const response = await this.run(() => this.admin.deleteAcls({ filters: [aclEntryOf(acl)] }));
    const first = response.filterResponses[0];
    if (first !== undefined && first.errorCode !== 0) {
      throw new DbError(
        'internal',
        first.errorMessage ?? msg('The cluster did not remove the rule'),
      );
    }
    return first?.matchingAcls.length ?? 0;
  }

  async describeConfig(target: KafkaConfigTarget): Promise<readonly KafkaConfigEntry[]> {
    const resource = configResource(target);
    const response = await this.run(() =>
      this.admin.describeConfigs({ resources: [resource], includeSynonyms: false }),
    );
    const first = response.resources[0];
    if (first?.errorCode !== 0) {
      const said = first?.errorMessage ?? '';
      throw new DbError(
        first?.errorCode === 3 ? 'not-found' : 'internal',
        said === '' ? msg('The cluster did not tell its settings') : said,
      );
    }
    return first.configEntries
      .map((entry) => ({
        name: entry.configName,
        value: entry.isSensitive ? '' : (entry.configValue ?? ''),
        overridden: entry.configSource === CONFIG_TOPIC || entry.configSource === CONFIG_DYNAMIC,
        sensitive: entry.isSensitive,
        readOnly: entry.readOnly,
        source: CONFIG_SOURCES[entry.configSource] ?? 'unknown',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setConfig(target: KafkaConfigTarget, name: string, value: string | null): Promise<void> {
    const current = await this.describeConfig(target);
    const entry = current.find((one) => one.name === name);
    if (entry === undefined) {
      throw new DbError('not-found', msg('The setting "{0}" does not exist here', name));
    }
    if (entry.readOnly) {
      throw new DbError('permission-denied', msg('The setting "{0}" cannot be changed', name));
    }
    // The call replaces all that is set on the resource, so what is set now is sent back.
    const kept = current.filter((one) => one.overridden && one.name !== name);
    if (kept.some((one) => one.sensitive) || (entry.sensitive && entry.overridden)) {
      throw new DbError(
        'unsupported',
        msg(
          'This resource has a secret setting the cluster never tells, so changing settings here would lose it',
        ),
      );
    }
    const entries = kept.map((one) => ({ name: one.name, value: one.value }));
    if (value !== null) {
      entries.push({ name, value });
    }
    const resource = configResource(target);
    await this.run(() =>
      this.admin.alterConfigs({
        validateOnly: false,
        resources: [{ ...resource, configEntries: entries }],
      }),
    );
    await this.untilConfigShows(target, name, value);
  }

  /**
   * A broker applies a changed setting a moment after it has answered, so a read right
   * away can still show the old value; this waits (a few seconds at most) until it shows.
   */
  private async untilConfigShows(
    target: KafkaConfigTarget,
    name: string,
    value: string | null,
  ): Promise<void> {
    for (let attempt = 0; attempt < CONFIG_SHOW_TRIES; attempt += 1) {
      const entry = (await this.describeConfig(target)).find((one) => one.name === name);
      if (entry !== undefined && (value === null ? !entry.overridden : entry.value === value)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIG_SHOW_WAIT_MS));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const producer = this.producer ?? (await this.producerOpening?.catch(() => undefined));
    await producer?.disconnect().catch(() => undefined);
    await this.admin.disconnect().catch(() => undefined);
  }

  private async openProducer(): Promise<KafkaProducerLike> {
    if (this.producer !== undefined) {
      return this.producer;
    }
    this.producerOpening ??= (async () => {
      const producer = this.client.producer({ allowAutoTopicCreation: false });
      await producer.connect();
      this.producer = producer;
      return producer;
    })();
    try {
      return await this.run(() => this.producerOpening ?? Promise.reject(new Error('closed')));
    } catch (error) {
      this.producerOpening = undefined;
      throw error;
    }
  }

  /**
   * kafkajs keeps asking for every topic its admin client (or producer) has ever named, so one that is
   * gone (deleted, or never there) would fail the next metadata call, and a new topic could
   * not be created. A fresh client starts with no such memory.
   */
  private async freshAdmin(): Promise<void> {
    const old = this.admin;
    const next = this.client.admin();
    try {
      await next.connect();
    } catch (error) {
      throw kafkaFailure(error);
    }
    this.admin = next;
    await old.disconnect().catch(() => undefined);
    // The producer has a cluster of its own with the same memory; the next send opens a new one.
    const producer = this.producer;
    this.producer = undefined;
    this.producerOpening = undefined;
    await producer?.disconnect().catch(() => undefined);
  }

  /** Runs a client call; whatever it throws becomes a DbError. */
  private async run<T>(call: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new DbError('connection-failed', msg('The Kafka session is closed'));
    }
    try {
      return await call();
    } catch (error) {
      const failure = kafkaFailure(error);
      if (failure.driverCode === 'UNKNOWN_TOPIC_OR_PARTITION') {
        await this.freshAdmin().catch(() => undefined);
      }
      throw failure;
    }
  }
}

export async function openKafkaSession(
  config: ResolvedConnectionConfig,
  factory: KafkaClientFactory = kafkajsFactory,
  registryFetch: RegistryFetch = globalRegistryFetch,
): Promise<KafkaSession> {
  const tls = await tlsMaterial(config);
  let client: KafkaClientLike;
  try {
    client = await factory(clientOptionsOf(config, tls));
  } catch (error) {
    throw kafkaFailure(error);
  }
  const registryUrl = config.kafka?.registry?.trim() ?? '';
  const user = config.user?.trim() ?? '';
  const registry =
    registryUrl === ''
      ? undefined
      : new SchemaRegistry(
          registryUrl,
          registryFetch,
          user === '' ? undefined : basicAuth(user, config.password ?? ''),
        );
  const session = new ClientSession(client, client.admin(), registry);
  try {
    await session.open();
  } catch (error) {
    await session.close();
    throw (
      (tls === undefined ? undefined : tlsFailure(error, tls.serverName)) ?? kafkaFailure(error)
    );
  }
  return session;
}

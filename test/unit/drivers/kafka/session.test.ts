import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  brokersOf,
  clientOptionsOf,
  isInternalTopic,
  messageOf,
  openKafkaSession,
  PEEK_GROUP_PREFIX,
} from '../../../../src/drivers/kafka/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeKafka, kafkaJsError } from '../../../helpers/fake-kafka';

const config = (extra: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig => ({
  id: 'k',
  name: 'Kafka',
  driver: 'kafka',
  host: 'broker',
  port: 9092,
  ...extra,
});

const text = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString('utf8');

async function open(cluster: FakeKafka, extra: Partial<ResolvedConnectionConfig> = {}) {
  return await openKafkaSession(config(extra), cluster.factory);
}

describe('brokersOf', () => {
  it('fills in the port box for a broker without a port', () => {
    expect(brokersOf('a, b:9093 ,c', 9094)).toEqual(['a:9094', 'b:9093', 'c:9094']);
  });

  it('defaults to port 9092 and to localhost', () => {
    expect(brokersOf('a', undefined)).toEqual(['a:9092']);
    expect(brokersOf(undefined, undefined)).toEqual(['localhost:9092']);
    expect(brokersOf(' , ', 9095)).toEqual(['localhost:9095']);
  });

  it('keeps one of a broker named twice', () => {
    expect(brokersOf('a:1,a:1,a', 1)).toEqual(['a:1']);
  });

  it('understands IPv6 addresses', () => {
    expect(brokersOf('[::1]:9093,[fe80::1]', 9092)).toEqual(['[::1]:9093', '[fe80::1]:9092']);
  });
});

describe('clientOptionsOf', () => {
  it('asks for no sign-in unless a mechanism is chosen', () => {
    const options = clientOptionsOf(config({ user: 'bob', password: 'x' }), undefined);
    expect(options.sasl).toBeUndefined();
    expect(options.ssl).toBeUndefined();
    expect(options.brokers).toEqual(['broker:9092']);
    expect(options.clientId).toBe('datanest');
  });

  it.each(['plain', 'scram-sha-256', 'scram-sha-512'] as const)('signs in with %s', (sasl) => {
    const options = clientOptionsOf(
      config({ user: ' bob ', password: 'secret', kafka: { sasl } }),
      undefined,
    );
    expect(options.sasl).toEqual({ mechanism: sasl, username: 'bob', password: 'secret' });
  });

  it('uses the connect timeout of the connection', () => {
    expect(
      clientOptionsOf(config({ options: { connectTimeout: 7 } }), undefined).connectionTimeout,
    ).toBe(7000);
  });

  it('checks the certificate unless the user only wants encryption', () => {
    const strict = clientOptionsOf(config(), {
      mode: 'verify-full',
      serverName: 'broker',
    });
    expect(strict.ssl).toMatchObject({ rejectUnauthorized: true, servername: 'broker' });
    const lax = clientOptionsOf(config(), { mode: 'require', serverName: '10.0.0.5' });
    expect(lax.ssl).toMatchObject({ rejectUnauthorized: false });
    // An IP address is no server name (RFC 6066).
    expect((lax.ssl as Record<string, unknown>).servername).toBeUndefined();
  });
});

describe('opening', () => {
  it('asks the cluster who it is', async () => {
    const cluster = new FakeKafka();
    cluster.brokers = 3;
    const session = await open(cluster);
    expect(session.server).toEqual({ clusterId: 'fake-cluster', brokers: 3 });
    expect(cluster.adminConnected).toBe(1);
  });

  it('turns a refused connection into an error and lets go of the client', async () => {
    const cluster = new FakeKafka();
    cluster.failures.set(
      'connect',
      kafkaJsError('KafkaJSConnectionError', 'Connection error: connect ECONNREFUSED', {
        code: 'ECONNREFUSED',
      }),
    );
    await expect(open(cluster)).rejects.toMatchObject({ code: 'connection-failed' });
    expect(cluster.adminDisconnected).toBe(1);
  });

  it('turns a failed sign-in into an auth error', async () => {
    const cluster = new FakeKafka();
    cluster.failures.set(
      'describeCluster',
      kafkaJsError('KafkaJSSASLAuthenticationError', 'SASL PLAIN authentication failed'),
    );
    await expect(open(cluster)).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('turns a client that cannot be built into an error', async () => {
    const cluster = new FakeKafka();
    cluster.failures.set('factory', new Error('boom'));
    await expect(open(cluster)).rejects.toBeInstanceOf(DbError);
  });
});

describe('topics', () => {
  it('lists topics in order and marks the cluster’s own', async () => {
    const cluster = new FakeKafka();
    cluster.addTopic('orders', 1);
    cluster.addTopic('__consumer_offsets', 1);
    cluster.addTopic('_schemas', 1);
    cluster.addTopic('audit', 1);
    const topics = await (await open(cluster)).listTopics();
    expect(topics.map((one) => one.name)).toEqual([
      '__consumer_offsets',
      '_schemas',
      'audit',
      'orders',
    ]);
    expect(topics.filter((one) => one.internal).map((one) => one.name)).toEqual([
      '__consumer_offsets',
      '_schemas',
    ]);
    expect(isInternalTopic('orders')).toBe(false);
  });

  it('describes partitions with their offsets, leader and replicas', async () => {
    const cluster = new FakeKafka();
    cluster.addTopic('orders', 2, 3);
    cluster.append('orders', 0, 'a');
    cluster.append('orders', 0, 'b');
    cluster.append('orders', 1, 'c');
    cluster.trim('orders', 0, 1);
    const details = await (await open(cluster)).describeTopic('orders');
    expect(details.partitions).toEqual([
      { partition: 0, low: '1', high: '2', leader: 1, replicas: 3, inSync: 3 },
      { partition: 1, low: '0', high: '1', leader: 1, replicas: 3, inSync: 3 },
    ]);
  });

  it('says a topic that is not there is not there', async () => {
    const session = await open(new FakeKafka());
    await expect(session.describeTopic('nope')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('creates and deletes a topic', async () => {
    const cluster = new FakeKafka();
    const session = await open(cluster);
    await session.createTopic('fresh', 3, 1);
    expect(cluster.topics.get('fresh')).toHaveLength(3);
    await session.deleteTopic('fresh');
    expect(cluster.topics.has('fresh')).toBe(false);
  });

  it('starts a fresh admin client after a topic was deleted, which forgets the dead topic', async () => {
    const cluster = new FakeKafka();
    cluster.addTopic('gone', 1);
    const session = await open(cluster);
    await session.deleteTopic('gone');
    expect(cluster.adminConnected).toBe(2);
    expect(cluster.adminDisconnected).toBe(1);
    // The new client works.
    await session.createTopic('again', 1, 1);
    expect((await session.listTopics()).map((one) => one.name)).toEqual(['again']);
    await session.close();
    expect(cluster.adminDisconnected).toBe(2);
  });

  it('starts a fresh admin client after a topic that is not there was asked for, too', async () => {
    const cluster = new FakeKafka();
    const session = await open(cluster);
    await expect(session.describeTopic('ghost')).rejects.toMatchObject({ code: 'not-found' });
    await expect(session.deleteTopic('ghost')).rejects.toMatchObject({ code: 'not-found' });
    // describeTopic did not fail with the broker's error here (the fake lists nothing), but
    // deleteTopic did: the client was renewed once.
    expect(cluster.adminConnected).toBeGreaterThanOrEqual(2);
  });

  it('starts a fresh producer after a topic was deleted', async () => {
    const cluster = new FakeKafka();
    cluster.addTopic('gone', 1);
    cluster.addTopic('kept', 1);
    const session = await open(cluster);
    await session.produce({ topic: 'kept', value: Buffer.from('1') });
    await session.deleteTopic('gone');
    expect(cluster.producerDisconnected).toBe(1);
    await session.produce({ topic: 'kept', value: Buffer.from('2') });
    await session.close();
    expect(cluster.producerDisconnected).toBe(2);
  });

  it('refuses to create a topic that exists', async () => {
    const cluster = new FakeKafka();
    cluster.addTopic('orders', 1);
    const session = await open(cluster);
    await expect(session.createTopic('orders', 1, 1)).rejects.toMatchObject({
      code: 'constraint',
      driverCode: 'TOPIC_ALREADY_EXISTS',
    });
  });

  it('refuses to delete a topic that is not there', async () => {
    const session = await open(new FakeKafka());
    await expect(session.deleteTopic('nope')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('reading messages', () => {
  function cluster(): FakeKafka {
    const one = new FakeKafka();
    one.addTopic('orders', 2);
    for (let i = 0; i < 10; i++) {
      one.append('orders', 0, `m${i}`, { key: `k${i}` });
    }
    one.append('orders', 1, 'other');
    return one;
  }

  it('reads the last messages of a partition', async () => {
    const fake = cluster();
    const messages = await (
      await open(fake)
    ).readMessages({
      topic: 'orders',
      partition: 0,
      count: 3,
      maxBytes: 1_000_000,
    });
    expect(messages.map((one) => text(one.value))).toEqual(['m7', 'm8', 'm9']);
    expect(messages.map((one) => one.offset)).toEqual(['7', '8', '9']);
    expect(text(messages[0]?.key ?? null)).toBe('k7');
    expect(messages.every((one) => one.partition === 0)).toBe(true);
  });

  it('reads from an offset, as many as asked', async () => {
    const messages = await (
      await open(cluster())
    ).readMessages({
      topic: 'orders',
      partition: 0,
      fromOffset: '2',
      count: 4,
      maxBytes: 1_000_000,
    });
    expect(messages.map((one) => one.offset)).toEqual(['2', '3', '4', '5']);
  });

  it('starts at the oldest message when the offset is older than any', async () => {
    const fake = cluster();
    fake.trim('orders', 0, 5);
    const messages = await (
      await open(fake)
    ).readMessages({
      topic: 'orders',
      partition: 0,
      fromOffset: '1',
      count: 2,
      maxBytes: 1_000_000,
    });
    expect(messages.map((one) => one.offset)).toEqual(['5', '6']);
  });

  it('returns nothing when the offset is past the end', async () => {
    const fake = cluster();
    const session = await open(fake);
    const messages = await session.readMessages({
      topic: 'orders',
      partition: 0,
      fromOffset: '99',
      count: 5,
      maxBytes: 1_000_000,
    });
    expect(messages).toEqual([]);
    // Nothing to read: no consumer was even made.
    expect(fake.consumers).toHaveLength(0);
  });

  it('returns nothing from an empty partition', async () => {
    const fake = new FakeKafka();
    fake.addTopic('empty', 1);
    expect(
      await (
        await open(fake)
      ).readMessages({
        topic: 'empty',
        partition: 0,
        count: 5,
        maxBytes: 1_000_000,
      }),
    ).toEqual([]);
  });

  it('stops once the messages hold the bytes it was allowed', async () => {
    const messages = await (
      await open(cluster())
    ).readMessages({
      topic: 'orders',
      partition: 0,
      fromOffset: '0',
      count: 10,
      maxBytes: 8,
    });
    // Each message is 2 + 2 bytes: the second one reaches 8.
    expect(messages.map((one) => one.offset)).toEqual(['0', '1']);
  });

  it('says a partition that is not there is not there', async () => {
    await expect(
      (await open(cluster())).readMessages({
        topic: 'orders',
        partition: 5,
        count: 1,
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('keeps tombstones, headers and timestamps', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 1);
    fake.append('t', 0, null, { key: 'gone', at: 1234 });
    fake.append('t', 0, 'v', {
      headers: { trace: Buffer.from('42'), many: [Buffer.from('a'), 'b'], text: 'plain' },
    });
    const messages = await (
      await open(fake)
    ).readMessages({
      topic: 't',
      partition: 0,
      count: 5,
      maxBytes: 1_000_000,
    });
    expect(messages[0]?.value).toBeNull();
    expect(messages[0]?.timestamp).toBe('1234');
    expect(messages[1]?.headers.map((header) => [header.name, text(header.value)])).toEqual([
      ['trace', '42'],
      ['many', 'a'],
      ['many', 'b'],
      ['text', 'plain'],
    ]);
  });

  it('joins no group of the user’s, commits nothing and always lets go', async () => {
    const fake = cluster();
    fake.commit('billing', 'orders', 0, 3);
    const before = fake.committedSnapshot();
    const session = await open(fake);
    await session.readMessages({ topic: 'orders', partition: 0, count: 3, maxBytes: 1_000_000 });
    await session.readMessages({ topic: 'orders', partition: 1, count: 3, maxBytes: 1_000_000 });
    expect(fake.consumers).toHaveLength(2);
    for (const consumer of fake.consumers) {
      expect(consumer.groupId.startsWith(PEEK_GROUP_PREFIX)).toBe(true);
      expect(consumer.autoCommit).toBe(false);
      expect(consumer.commits).toBe(0);
      expect(consumer.disconnected).toBe(true);
    }
    // Each read has a group of its own.
    expect(new Set(fake.consumers.map((one) => one.groupId)).size).toBe(2);
    expect(fake.committedSnapshot()).toBe(before);
  });

  it('seeks to its start and pauses the other partitions', async () => {
    const fake = cluster();
    await (
      await open(fake)
    ).readMessages({
      topic: 'orders',
      partition: 0,
      count: 2,
      maxBytes: 1_000_000,
    });
    const consumer = fake.consumers[0];
    expect(consumer?.seeks).toEqual([{ partition: 0, offset: '8' }]);
    expect(consumer?.paused).toEqual([1]);
    expect(consumer?.delivered.every((one) => one.startsWith('0:'))).toBe(true);
  });

  it('lets go of the consumer when reading fails', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 1);
    fake.append('t', 0, 'a');
    const session = await open(fake);
    fake.topics.delete('t');
    // The offsets are fetched first, so the failure is the broker's own answer.
    await expect(
      session.readMessages({ topic: 't', partition: 0, count: 1, maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('returns what it has when the broker takes too long', async () => {
    const fake = cluster();
    fake.silent = true;
    const session = await open(fake);
    const messages = await session.readMessages({
      topic: 'orders',
      partition: 0,
      count: 3,
      maxBytes: 1_000_000,
      timeoutMs: 20,
    });
    expect(messages).toEqual([]);
  });

  it('stops when told to', async () => {
    const fake = cluster();
    fake.silent = true;
    const session = await open(fake);
    const abort = new AbortController();
    const pending = session.readMessages({
      topic: 'orders',
      partition: 0,
      count: 3,
      maxBytes: 1_000_000,
      signal: abort.signal,
    });
    setTimeout(() => {
      abort.abort();
    }, 10);
    await expect(pending).resolves.toEqual([]);
    const already = new AbortController();
    already.abort();
    await expect(
      session.readMessages({
        topic: 'orders',
        partition: 0,
        count: 3,
        maxBytes: 1_000_000,
        signal: already.signal,
      }),
    ).resolves.toEqual([]);
  });

  it('shows a message as bytes with every header', () => {
    const view = messageOf(3, {
      key: Buffer.from('k'),
      value: null,
      timestamp: '9',
      offset: '5',
      headers: { a: Buffer.from('1'), b: undefined },
    });
    expect(view.partition).toBe(3);
    expect(view.headers.map((one) => one.name)).toEqual(['a']);
  });
});

describe('offsets by time', () => {
  it('finds the first message at or after a moment, per partition', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 2);
    fake.append('t', 0, 'a', { at: 100 });
    fake.append('t', 0, 'b', { at: 200 });
    fake.append('t', 1, 'c', { at: 50 });
    const found = await (await open(fake)).offsetsForTime('t', 150);
    expect(found.get(0)).toBe('1');
    // After the last message the answer is the end offset, as kafkajs gives it.
    expect(found.get(1)).toBe('1');
  });
});

describe('consumer groups', () => {
  it('lists groups with state and members, and hides the throw-away ones', async () => {
    const fake = new FakeKafka();
    fake.addTopic('orders', 1);
    fake.commit('billing', 'orders', 0, 1);
    fake.commit(`${PEEK_GROUP_PREFIX}abc`, 'orders', 0, 0);
    fake.groupStates.set('idle', 'Empty');
    const groups = await (await open(fake)).listGroups();
    expect(groups).toEqual([
      { id: 'billing', state: 'Stable', members: 2 },
      { id: 'idle', state: 'Empty', members: 0 },
    ]);
  });

  it('lists nothing when there are only throw-away groups', async () => {
    const fake = new FakeKafka();
    fake.commit(`${PEEK_GROUP_PREFIX}abc`, 'orders', 0, 0);
    expect(await (await open(fake)).listGroups()).toEqual([]);
  });

  it('counts the messages a group has not read', async () => {
    const fake = new FakeKafka();
    fake.addTopic('orders', 2);
    for (let i = 0; i < 10; i++) {
      fake.append('orders', 0, 'x');
    }
    fake.append('orders', 1, 'y');
    fake.commit('billing', 'orders', 0, 4);
    fake.commit('billing', 'orders', 1, 1);
    const lag = await (await open(fake)).groupLag('billing');
    expect(lag).toEqual([
      { topic: 'orders', partition: 0, committed: '4', high: '10', lag: '6' },
      { topic: 'orders', partition: 1, committed: '1', high: '1', lag: '0' },
    ]);
  });

  it('counts from the start when nothing is committed, and never below zero', async () => {
    const fake = new FakeKafka();
    fake.addTopic('orders', 2);
    fake.append('orders', 0, 'a');
    fake.append('orders', 0, 'b');
    fake.trim('orders', 0, 1);
    fake.commit('g', 'orders', 0, -1);
    fake.commit('g', 'orders', 1, 7);
    const lag = await (await open(fake)).groupLag('g');
    expect(lag[0]).toEqual({ topic: 'orders', partition: 0, committed: '', high: '2', lag: '1' });
    expect(lag[1]?.lag).toBe('0');
  });

  it('has no lag for a group without offsets', async () => {
    expect(await (await open(new FakeKafka())).groupLag('ghost')).toEqual([]);
  });
});

describe('producing', () => {
  it('sends a message with key, value, partition and headers', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 3);
    const session = await open(fake);
    const produced = await session.produce({
      topic: 't',
      partition: 2,
      key: Buffer.from('k'),
      value: Buffer.from('v'),
      headers: [
        { name: 'a', value: Buffer.from('1') },
        { name: 'a', value: Buffer.from('2') },
        { name: 'b', value: Buffer.from('3') },
      ],
    });
    expect(produced).toEqual({ partition: 2, offset: '0' });
    const sent = fake.sent[0]?.messages[0] as {
      key: Buffer;
      value: Buffer;
      headers: Record<string, unknown>;
    };
    expect(sent.key.toString()).toBe('k');
    expect(sent.value.toString()).toBe('v');
    expect(Object.keys(sent.headers)).toEqual(['a', 'b']);
    expect(Array.isArray(sent.headers.a)).toBe(true);
  });

  it('sends a tombstone and a message without a key', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 1);
    const session = await open(fake);
    await session.produce({ topic: 't', value: null });
    const sent = fake.sent[0]?.messages[0] as { key: unknown; value: unknown };
    expect(sent.value).toBeNull();
    expect(sent.key).toBeNull();
  });

  it('reuses the producer for the next message and lets go of it at the end', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 1);
    const session = await open(fake);
    await session.produce({ topic: 't', value: Buffer.from('1') });
    await session.produce({ topic: 't', value: Buffer.from('2') });
    await session.close();
    expect(fake.producerDisconnected).toBe(1);
    expect(fake.adminDisconnected).toBe(1);
  });

  it('refuses a partition the broker rejects', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 1);
    const session = await open(fake);
    await expect(
      session.produce({ topic: 't', partition: 9, value: Buffer.from('x') }),
    ).rejects.toMatchObject({ code: 'internal' });
  });

  it('turns the broker’s refusal into an error', async () => {
    const fake = new FakeKafka();
    fake.addTopic('t', 1);
    const session = await open(fake);
    fake.failures.set(
      'send',
      kafkaJsError('KafkaJSProtocolError', 'not authorized', {
        type: 'TOPIC_AUTHORIZATION_FAILED',
      }),
    );
    await expect(session.produce({ topic: 't', value: Buffer.from('x') })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('a closed session', () => {
  it('refuses every call and closes twice without harm', async () => {
    const session = await open(new FakeKafka());
    await session.close();
    await session.close();
    await expect(session.listTopics()).rejects.toMatchObject({ code: 'connection-failed' });
  });
});

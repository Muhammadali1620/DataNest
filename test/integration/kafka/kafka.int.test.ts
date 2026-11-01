import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/kafka';
import type { KafkaSession } from '../../../src/drivers/kafka-driver';
import { PEEK_GROUP_PREFIX } from '../../../src/drivers/kafka/session';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { KafkaTopicModel } from '../../../src/vscode/panels/kafka-topic-model';
import { TEST_KAFKA } from '../../helpers/kafka-servers';

// docker/compose.yml `kafka` (V13.23): one KRaft node, plain text, no sign-in.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'test-kafka',
    name: 'Kafka',
    driver: 'kafka',
    host: TEST_KAFKA.host,
    port: TEST_KAFKA.port,
    ...overrides,
  };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : new TextDecoder().decode(bytes);

const unique = (name: string): string => `dn-it-${name}-${randomUUID().slice(0, 8)}`;

describe('Kafka (V13.23)', () => {
  let session: KafkaSession;
  const made: string[] = [];
  // The client the tests use on their own, to play the part of another application.
  const outside = new Kafka({
    clientId: 'dn-it-outside',
    brokers: [`${TEST_KAFKA.host}:${TEST_KAFKA.port}`],
    logLevel: logLevel.NOTHING,
  });
  const outsideAdmin = outside.admin();

  async function topic(name: string, partitions = 1): Promise<string> {
    const full = unique(name);
    await session.createTopic(full, partitions, 1);
    made.push(full);
    return full;
  }

  beforeAll(async () => {
    session = await driver.openSession(config());
    await outsideAdmin.connect();
  }, 60_000);

  afterAll(async () => {
    for (const name of made) {
      await session.deleteTopic(name).catch(() => undefined);
    }
    await outsideAdmin.disconnect();
    await session.close();
  });

  it('knows the cluster it reached', () => {
    expect(session.server.brokers).toBe(1);
    expect(session.server.clusterId).not.toBe('');
  });

  it('creates a topic, lists it and describes its partitions', async () => {
    const name = await topic('shape', 3);
    const topics = await session.listTopics();
    expect(topics.find((one) => one.name === name)).toEqual({ name, internal: false });
    const details = await session.describeTopic(name);
    expect(details.partitions.map((one) => one.partition)).toEqual([0, 1, 2]);
    for (const part of details.partitions) {
      expect(part).toMatchObject({ low: '0', high: '0', replicas: 1, inSync: 1 });
      expect(part.leader).toBeGreaterThanOrEqual(0);
    }
  });

  it('hides nothing the broker has, and marks its own topics as internal', async () => {
    // `__consumer_offsets` appears once any group has committed; make that happen.
    const name = await topic('internal');
    await session.produce({ topic: name, value: encode('x') });
    await outsideAdmin.setOffsets({
      groupId: unique('seed-group'),
      topic: name,
      partitions: [{ partition: 0, offset: '1' }],
    });
    const topics = await session.listTopics();
    expect(topics.find((one) => one.name === '__consumer_offsets')?.internal).toBe(true);
  });

  it('refuses a topic that is there already, and one that is not', async () => {
    const name = await topic('twice');
    await expect(session.createTopic(name, 1, 1)).rejects.toMatchObject({ code: 'constraint' });
    await expect(session.describeTopic(unique('ghost'))).rejects.toBeDefined();
    await expect(session.deleteTopic(unique('ghost'))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('sends messages and reads the last ones back, bytes and all', async () => {
    const name = await topic('roundtrip');
    const binary = Uint8Array.from([0, 255, 128, 10, 13]);
    for (let i = 0; i < 5; i++) {
      await session.produce({
        topic: name,
        partition: 0,
        key: encode(`k${i}`),
        value: i === 4 ? binary : encode(`value ${i}`),
        headers: [
          { name: 'n', value: encode(String(i)) },
          { name: 'n', value: encode('again') },
        ],
      });
    }
    const messages = await session.readMessages({
      topic: name,
      partition: 0,
      count: 3,
      maxBytes: 1_000_000,
    });
    expect(messages.map((one) => one.offset)).toEqual(['2', '3', '4']);
    expect(messages.map((one) => decode(one.key))).toEqual(['k2', 'k3', 'k4']);
    expect(decode(messages[0]?.value ?? null)).toBe('value 2');
    expect([...(messages[2]?.value ?? [])]).toEqual([...binary]);
    expect(messages[0]?.headers.map((one) => [one.name, decode(one.value)])).toEqual([
      ['n', '2'],
      ['n', 'again'],
    ]);
    expect(Number(messages[0]?.timestamp)).toBeGreaterThan(1_600_000_000_000);
  });

  it('reads from an offset, and from the start when the offset is too old', async () => {
    const name = await topic('offsets');
    for (let i = 0; i < 6; i++) {
      await session.produce({ topic: name, partition: 0, value: encode(`m${i}`) });
    }
    const from = await session.readMessages({
      topic: name,
      partition: 0,
      fromOffset: '2',
      count: 2,
      maxBytes: 1_000_000,
    });
    expect(from.map((one) => decode(one.value))).toEqual(['m2', 'm3']);
    const all = await session.readMessages({
      topic: name,
      partition: 0,
      fromOffset: '0',
      count: 100,
      maxBytes: 1_000_000,
    });
    expect(all).toHaveLength(6);
    expect(
      await session.readMessages({
        topic: name,
        partition: 0,
        fromOffset: '99',
        count: 5,
        maxBytes: 1_000_000,
      }),
    ).toEqual([]);
  });

  it('reads only the partition it was asked for', async () => {
    const name = await topic('partitions', 3);
    await session.produce({ topic: name, partition: 0, value: encode('zero') });
    await session.produce({ topic: name, partition: 2, value: encode('two') });
    const two = await session.readMessages({
      topic: name,
      partition: 2,
      count: 10,
      maxBytes: 1_000_000,
    });
    expect(two.map((one) => decode(one.value))).toEqual(['two']);
    expect(two[0]?.partition).toBe(2);
    expect(
      await session.readMessages({ topic: name, partition: 1, count: 10, maxBytes: 1_000_000 }),
    ).toEqual([]);
  });

  it('finds the offset of a moment in time', async () => {
    const name = await topic('time');
    await session.produce({ topic: name, partition: 0, value: encode('old') });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const between = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.produce({ topic: name, partition: 0, value: encode('new') });
    const found = await session.offsetsForTime(name, between);
    expect(found.get(0)).toBe('1');
    const none = await session.offsetsForTime(name, Date.now() + 3_600_000);
    // After the last message the answer is the end offset.
    expect(none.get(0)).toBe('2');
  });

  it('keeps a tombstone as a message without a value', async () => {
    const name = await topic('tombstone');
    await session.produce({ topic: name, partition: 0, key: encode('gone'), value: null });
    const [message] = await session.readMessages({
      topic: name,
      partition: 0,
      count: 1,
      maxBytes: 1_000_000,
    });
    expect(decode(message?.key ?? null)).toBe('gone');
    expect(message?.value).toBeNull();
  });

  it('never moves what a consumer group has read, and leaves no group behind', async () => {
    const name = await topic('invariant');
    for (let i = 0; i < 8; i++) {
      await session.produce({ topic: name, partition: 0, value: encode(`m${i}`) });
    }
    const group = unique('billing');
    await outsideAdmin.setOffsets({
      groupId: group,
      topic: name,
      partitions: [{ partition: 0, offset: '3' }],
    });
    const before = await outsideAdmin.fetchOffsets({ groupId: group, topics: [name] });

    for (let i = 0; i < 3; i++) {
      await session.readMessages({ topic: name, partition: 0, count: 8, maxBytes: 1_000_000 });
    }

    const after = await outsideAdmin.fetchOffsets({ groupId: group, topics: [name] });
    expect(after).toEqual(before);
    expect(after[0]?.partitions[0]?.offset).toBe('3');
    // The throw-away groups of the reads are not listed, whether or not the broker still has them.
    const listed = await session.listGroups();
    expect(listed.some((one) => one.id.startsWith(PEEK_GROUP_PREFIX))).toBe(false);
    expect(listed.find((one) => one.id === group)).toMatchObject({ id: group });
  });

  it('counts how far behind a group is', async () => {
    const name = await topic('lag', 2);
    for (let i = 0; i < 10; i++) {
      await session.produce({ topic: name, partition: 0, value: encode('x') });
    }
    await session.produce({ topic: name, partition: 1, value: encode('y') });
    const group = unique('lagging');
    await outsideAdmin.setOffsets({
      groupId: group,
      topic: name,
      partitions: [
        { partition: 0, offset: '4' },
        { partition: 1, offset: '1' },
      ],
    });
    const lag = await session.groupLag(group);
    expect(lag).toEqual([
      { topic: name, partition: 0, committed: '4', high: '10', lag: '6' },
      { topic: name, partition: 1, committed: '1', high: '1', lag: '0' },
    ]);
    expect(await session.groupLag(unique('nobody'))).toEqual([]);
  });

  it('works through the topic page model, start to end', async () => {
    const name = await topic('model', 2);
    const model = new KafkaTopicModel({
      topic: name,
      internal: false,
      connectionName: 'Kafka',
      readOnly: false,
      session: () => Promise.resolve(session),
    });
    const sent = await model.produce({
      partition: 1,
      key: { text: 'id-1' },
      value: { text: '{"a":1}' },
      headers: [{ name: 'trace', value: '42' }],
    });
    expect(sent).toMatchObject({ partition: 1, offset: '0' });
    expect(sent.state.partitions[1]).toMatchObject({ high: '1' });
    expect(sent.state.partition).toBe(1);
    const state = await model.readMessages({ partition: 1, mode: 'last', count: 5 });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      offset: '0',
      key: { text: 'id-1' },
      value: { text: '{"a":1}' },
    });
    expect(state.messages[0]?.headers).toEqual([{ name: 'trace', value: { text: '42' } }]);
    await model.deleteTopic();
    made.splice(made.indexOf(name), 1);
    await expect(session.describeTopic(name)).rejects.toBeDefined();
  });

  it('stops reading when told to', async () => {
    const name = await topic('abort');
    for (let i = 0; i < 3; i++) {
      await session.produce({ topic: name, partition: 0, value: encode('x') });
    }
    const abort = new AbortController();
    abort.abort();
    const started = Date.now();
    const messages = await session.readMessages({
      topic: name,
      partition: 0,
      count: 3,
      maxBytes: 1_000_000,
      signal: abort.signal,
    });
    expect(messages.length).toBeLessThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('says a broker that is not there is not there', async () => {
    await expect(
      driver.openSession(config({ port: 1, options: { connectTimeout: 1 } })),
    ).rejects.toMatchObject({ code: 'connection-failed' });
  }, 60_000);
});

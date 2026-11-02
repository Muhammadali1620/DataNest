import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/kafka';
import type { KafkaMessage, KafkaSession } from '../../../src/drivers/kafka-driver';
import { PEEK_GROUP_PREFIX } from '../../../src/drivers/kafka/session';
import { TEST_KAFKA } from '../../helpers/kafka-servers';

// V13.29 against the real broker (docker/compose.yml `kafka`): following a partition live
// and moving the offsets of a group that has none running.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | null): string =>
  bytes === null ? '' : new TextDecoder().decode(bytes);
const unique = (name: string): string => `dn-it-${name}-${randomUUID().slice(0, 8)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await wait(100);
  }
}

describe('Kafka: live reading and offset reset (V13.29)', () => {
  let session: KafkaSession;
  const made: string[] = [];
  const outside = new Kafka({
    clientId: 'dn-it-live',
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
    session = await driver.openSession({
      id: 'test-kafka',
      name: 'Kafka',
      driver: 'kafka',
      host: TEST_KAFKA.host,
      port: TEST_KAFKA.port,
    });
    await outsideAdmin.connect();
  }, 60_000);

  afterAll(async () => {
    for (const name of made) {
      await session.deleteTopic(name).catch(() => undefined);
    }
    await outsideAdmin.disconnect();
    await session.close();
  });

  it('follows a partition: old messages stay out, new ones arrive in order', async () => {
    const name = await topic('live', 2);
    await session.produce({ topic: name, partition: 0, value: encode('old') });
    const got: KafkaMessage[] = [];
    const abort = new AbortController();
    const done = session.watchMessages(
      { topic: name, partition: 0, signal: abort.signal },
      (messages) => got.push(...messages),
    );
    // The group needs a moment to join before it can see anything.
    await wait(4000);
    await session.produce({ topic: name, partition: 0, value: encode('one') });
    await session.produce({ topic: name, partition: 1, value: encode('elsewhere') });
    await session.produce({ topic: name, partition: 0, value: encode('two') });
    await until(() => got.length >= 2);
    abort.abort();
    await done;
    expect(got.map((one) => decode(one.value))).toEqual(['one', 'two']);
    expect(got.map((one) => one.offset)).toEqual(['1', '2']);
    expect(got.every((one) => one.partition === 0)).toBe(true);
  }, 90_000);

  it('follows from an offset, and moves no group of the user’s, and leaves no group behind', async () => {
    const name = await topic('live-from');
    for (const text of ['a', 'b', 'c']) {
      await session.produce({ topic: name, partition: 0, value: encode(text) });
    }
    const group = unique('watched');
    await outsideAdmin.setOffsets({
      groupId: group,
      topic: name,
      partitions: [{ partition: 0, offset: '1' }],
    });
    const before = await outsideAdmin.fetchOffsets({ groupId: group, topics: [name] });
    const got: string[] = [];
    const abort = new AbortController();
    const done = session.watchMessages(
      { topic: name, partition: 0, fromOffset: '1', signal: abort.signal },
      (messages) => got.push(...messages.map((one) => decode(one.value))),
    );
    await until(() => got.length >= 2);
    abort.abort();
    await done;
    expect(got).toEqual(['b', 'c']);
    expect(await outsideAdmin.fetchOffsets({ groupId: group, topics: [name] })).toEqual(before);
    expect((await session.listGroups()).some((one) => one.id.startsWith(PEEK_GROUP_PREFIX))).toBe(
      false,
    );
  }, 90_000);

  it('stops at once when told to', async () => {
    const name = await topic('live-stop');
    const abort = new AbortController();
    const done = session.watchMessages(
      { topic: name, partition: 0, signal: abort.signal },
      () => undefined,
    );
    await wait(500);
    const started = Date.now();
    abort.abort();
    await done;
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it('says a partition that is not there is not there', async () => {
    const name = await topic('live-gone');
    await expect(
      session.watchMessages(
        { topic: name, partition: 7, signal: new AbortController().signal },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  describe('resetting the offsets of a group', () => {
    async function seeded(): Promise<{ name: string; group: string }> {
      const name = await topic('reset', 2);
      for (let i = 0; i < 6; i++) {
        await session.produce({ topic: name, partition: 0, value: encode(`m${i}`) });
      }
      await session.produce({ topic: name, partition: 1, value: encode('x') });
      const group = unique('resetting');
      await outsideAdmin.setOffsets({
        groupId: group,
        topic: name,
        partitions: [
          { partition: 0, offset: '4' },
          { partition: 1, offset: '1' },
        ],
      });
      return { name, group };
    }

    const committed = async (group: string, name: string): Promise<string[]> => {
      const found = await outsideAdmin.fetchOffsets({ groupId: group, topics: [name] });
      return (found[0]?.partitions ?? [])
        .sort((a, b) => a.partition - b.partition)
        .map((one) => one.offset);
    };

    it('moves to the beginning and to the end, and says where each partition was', async () => {
      const { name, group } = await seeded();
      const start = await session.resetGroupOffsets(group, name, { kind: 'earliest' });
      expect(start).toEqual([
        { partition: 0, before: '4', offset: '0' },
        { partition: 1, before: '1', offset: '0' },
      ]);
      expect(await committed(group, name)).toEqual(['0', '0']);
      const end = await session.resetGroupOffsets(group, name, { kind: 'latest' });
      expect(end.map((one) => one.offset)).toEqual(['6', '1']);
      expect(await committed(group, name)).toEqual(['6', '1']);
      expect(await session.groupLag(group)).toEqual([
        { topic: name, partition: 0, committed: '6', high: '6', lag: '0' },
        { topic: name, partition: 1, committed: '1', high: '1', lag: '0' },
      ]);
    });

    it('moves to an offset held inside what each partition stores', async () => {
      const { name, group } = await seeded();
      const done = await session.resetGroupOffsets(group, name, { kind: 'offset', offset: '3' });
      expect(done.map((one) => one.offset)).toEqual(['3', '1']);
      expect(await committed(group, name)).toEqual(['3', '1']);
    });

    it('moves to a moment in time, and to the end for a moment past the last message', async () => {
      const { name, group } = await seeded();
      const past = await session.resetGroupOffsets(group, name, {
        kind: 'time',
        timestamp: Date.now() + 3_600_000,
      });
      expect(past.map((one) => one.offset)).toEqual(['6', '1']);
      const first = await session.resetGroupOffsets(group, name, { kind: 'time', timestamp: 0 });
      expect(first.map((one) => one.offset)).toEqual(['0', '0']);
    });

    it('moves a group that has no offsets on the topic yet, once it exists', async () => {
      const { name, group } = await seeded();
      const other = await topic('reset-other');
      await session.produce({ topic: other, partition: 0, value: encode('y') });
      await outsideAdmin.setOffsets({
        groupId: group,
        topic: other,
        partitions: [{ partition: 0, offset: '0' }],
      });
      const done = await session.resetGroupOffsets(group, other, { kind: 'latest' });
      expect(done).toEqual([{ partition: 0, before: '0', offset: '1' }]);
      expect(await committed(group, name)).toEqual(['4', '1']);
    });

    it('refuses a group that a consumer is running in, and changes nothing', async () => {
      const { name, group } = await seeded();
      const consumer = outside.consumer({ groupId: group });
      await consumer.connect();
      await consumer.subscribe({ topic: name, fromBeginning: true });
      let seen = 0;
      await consumer.run({
        eachMessage: () => {
          seen += 1;
          return Promise.resolve();
        },
      });
      try {
        await until(() => seen > 0);
        await expect(
          session.resetGroupOffsets(group, name, { kind: 'earliest' }),
        ).rejects.toMatchObject({ code: 'constraint', driverCode: 'NON_EMPTY_GROUP' });
      } finally {
        await consumer.disconnect();
      }
    }, 90_000);

    it('says a group that does not exist does not exist', async () => {
      const name = await topic('reset-none');
      await expect(
        session.resetGroupOffsets(unique('ghost'), name, { kind: 'earliest' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });
});

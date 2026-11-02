import { describe, expect, it } from 'vitest';
import { openKafkaSession, PEEK_GROUP_PREFIX } from '../../../../src/drivers/kafka/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeKafka, kafkaJsError } from '../../../helpers/fake-kafka';

const config: ResolvedConnectionConfig = {
  id: 'k',
  name: 'Kafka',
  driver: 'kafka',
  host: 'broker',
  port: 9092,
};

const text = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString('utf8');

const open = async (cluster: FakeKafka) => await openKafkaSession(config, cluster.factory);

describe('watching a partition live (V13.29)', () => {
  const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

  async function watch(fake: FakeKafka, request: { partition?: number; fromOffset?: string } = {}) {
    const session = await open(fake);
    const abort = new AbortController();
    const got: string[] = [];
    const done = session.watchMessages(
      {
        topic: 'live',
        partition: request.partition ?? 0,
        ...(request.fromOffset === undefined ? {} : { fromOffset: request.fromOffset }),
        signal: abort.signal,
      },
      (messages) => {
        for (const message of messages) {
          got.push(`${message.partition}:${message.offset}:${text(message.value) ?? ''}`);
        }
      },
    );
    return { abort, got, done, session };
  }

  it('brings only messages that arrive after it started', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 1);
    fake.append('live', 0, 'old');
    const { abort, got, done } = await watch(fake);
    await tick();
    expect(got).toEqual([]);
    fake.append('live', 0, 'one');
    fake.append('live', 0, 'two');
    await tick();
    expect(got).toEqual(['0:1:one', '0:2:two']);
    abort.abort();
    await done;
  });

  it('starts at an offset when asked, clamped to what the partition stores', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 1);
    for (const value of ['a', 'b', 'c']) {
      fake.append('live', 0, value);
    }
    const first = await watch(fake, { fromOffset: '1' });
    await tick();
    expect(first.got).toEqual(['0:1:b', '0:2:c']);
    first.abort.abort();
    await first.done;
    const past = await watch(fake, { fromOffset: '99' });
    await tick();
    expect(past.got).toEqual([]);
    fake.append('live', 0, 'd');
    await tick();
    expect(past.got).toEqual(['0:3:d']);
    past.abort.abort();
    await past.done;
    const junk = await watch(fake, { fromOffset: 'x' });
    await tick();
    expect(junk.got).toEqual([]);
    junk.abort.abort();
    await junk.done;
  });

  it('follows the one partition and leaves the others alone', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 2);
    const { abort, got, done } = await watch(fake, { partition: 1 });
    await tick();
    fake.append('live', 0, 'zero');
    fake.append('live', 1, 'one');
    await tick();
    expect(got).toEqual(['1:0:one']);
    abort.abort();
    await done;
  });

  it('joins no group of the user’s, commits nothing and lets go when stopped', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 1);
    fake.commit('billing', 'live', 0, 0);
    const before = fake.committedSnapshot();
    const { abort, done } = await watch(fake);
    await tick();
    const consumer = fake.consumers.at(-1);
    expect(consumer?.groupId.startsWith(PEEK_GROUP_PREFIX)).toBe(true);
    expect(consumer?.autoCommit).toBe(false);
    abort.abort();
    await done;
    expect(consumer?.disconnected).toBe(true);
    expect(fake.committedSnapshot()).toBe(before);
  });

  it('does not deliver after it was stopped', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 1);
    const { abort, got, done } = await watch(fake);
    await tick();
    abort.abort();
    await done;
    fake.append('live', 0, 'late');
    await tick();
    expect(got).toEqual([]);
  });

  it('ends at once when it was stopped before it began', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 1);
    const session = await open(fake);
    const abort = new AbortController();
    abort.abort();
    await session.watchMessages({ topic: 'live', partition: 0, signal: abort.signal }, () => {
      throw new Error('nothing to deliver');
    });
    expect(fake.consumers.at(-1)?.disconnected).toBe(true);
  });

  it('says a partition or topic that is not there is not there', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 1);
    const session = await open(fake);
    const signal = new AbortController().signal;
    await expect(
      session.watchMessages({ topic: 'live', partition: 5, signal }, () => undefined),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      session.watchMessages({ topic: 'nope', partition: 0, signal }, () => undefined),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('resetting the offsets of a group (V13.29)', () => {
  function cluster() {
    const fake = new FakeKafka();
    fake.addTopic('orders', 2);
    for (let i = 0; i < 6; i++) {
      fake.append('orders', 0, `m${i}`, { at: 1000 * (i + 1) });
    }
    fake.append('orders', 1, 'x', { at: 500 });
    fake.append('orders', 1, 'y', { at: 9000 });
    fake.trim('orders', 0, 2);
    fake.commit('billing', 'orders', 0, 5);
    fake.groupStates.set('billing', 'Empty');
    return fake;
  }

  it('moves every partition to the start, and says where each one was', async () => {
    const fake = cluster();
    const session = await open(fake);
    const done = await session.resetGroupOffsets('billing', 'orders', { kind: 'earliest' });
    expect(done).toEqual([
      { partition: 0, before: '5', offset: '2' },
      { partition: 1, before: '', offset: '0' },
    ]);
    expect(fake.setOffsetCalls).toEqual([
      {
        groupId: 'billing',
        topic: 'orders',
        partitions: [
          { partition: 0, offset: '2' },
          { partition: 1, offset: '0' },
        ],
      },
    ]);
    const lag = await session.groupLag('billing');
    expect(lag.map((one) => one.committed)).toEqual(['2', '0']);
  });

  it('moves every partition to the end', async () => {
    const done = await (
      await open(cluster())
    ).resetGroupOffsets('billing', 'orders', { kind: 'latest' });
    expect(done.map((one) => one.offset)).toEqual(['6', '2']);
  });

  it('takes one offset for all partitions, held inside what each one stores', async () => {
    const session = await open(cluster());
    const done = await session.resetGroupOffsets('billing', 'orders', {
      kind: 'offset',
      offset: '4',
    });
    expect(done.map((one) => one.offset)).toEqual(['4', '2']);
    const low = await session.resetGroupOffsets('billing', 'orders', {
      kind: 'offset',
      offset: '0',
    });
    expect(low.map((one) => one.offset)).toEqual(['2', '0']);
    const bad = await session.resetGroupOffsets('billing', 'orders', {
      kind: 'offset',
      offset: 'abc',
    });
    expect(bad.map((one) => one.offset)).toEqual(['2', '0']);
  });

  it('moves to the first message at or after a moment, and to the end past the last one', async () => {
    const session = await open(cluster());
    const at = await session.resetGroupOffsets('billing', 'orders', {
      kind: 'time',
      timestamp: 4000,
    });
    // Partition 0 keeps offsets 2–5 (times 3000–6000); partition 1 holds times 500 and 9000.
    expect(at.map((one) => one.offset)).toEqual(['3', '1']);
    const past = await session.resetGroupOffsets('billing', 'orders', {
      kind: 'time',
      timestamp: 99_000,
    });
    expect(past.map((one) => one.offset)).toEqual(['6', '2']);
  });

  it('refuses a group that has live members', async () => {
    const fake = cluster();
    fake.groupStates.set('billing', 'Stable');
    const session = await open(fake);
    await expect(
      session.resetGroupOffsets('billing', 'orders', { kind: 'earliest' }),
    ).rejects.toMatchObject({ code: 'constraint', driverCode: 'NON_EMPTY_GROUP' });
    expect(fake.setOffsetCalls).toEqual([]);
  });

  it('refuses a group that is dead', async () => {
    const fake = cluster();
    fake.groupStates.set('gone', 'Dead');
    const session = await open(fake);
    await expect(
      session.resetGroupOffsets('gone', 'orders', { kind: 'earliest' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('says a topic that is not there is not there', async () => {
    const session = await open(cluster());
    await expect(
      session.resetGroupOffsets('billing', 'nope', { kind: 'earliest' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a topic without partitions', async () => {
    const fake = cluster();
    fake.topics.set('empty', []);
    const session = await open(fake);
    await expect(
      session.resetGroupOffsets('billing', 'empty', { kind: 'earliest' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('turns the broker’s refusal into an error', async () => {
    const fake = cluster();
    const session = await open(fake);
    fake.failures.set(
      'setOffsets',
      kafkaJsError('KafkaJSProtocolError', 'not authorized', {
        type: 'GROUP_AUTHORIZATION_FAILED',
      }),
    );
    await expect(
      session.resetGroupOffsets('billing', 'orders', { kind: 'latest' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

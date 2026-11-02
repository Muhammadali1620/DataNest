import { describe, expect, it } from 'vitest';
import { openKafkaSession } from '../../../../src/drivers/kafka/session';
import type { KafkaSession } from '../../../../src/drivers/kafka-driver';
import { KafkaTopicModel } from '../../../../src/vscode/panels/kafka-topic-model';
import { MAX_KAFKA_COUNT } from '../../../../src/shared/protocols/kafka-topic';
import { FakeKafka } from '../../../helpers/fake-kafka';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(options: { readOnly?: boolean; session?: KafkaSession } = {}) {
  const cluster = new FakeKafka();
  cluster.addTopic('orders', 2);
  cluster.append('orders', 0, 'old');
  const session =
    options.session ??
    (await openKafkaSession(
      { id: 'k', name: 'Kafka', driver: 'kafka', host: 'h' },
      cluster.factory,
    ));
  const model = new KafkaTopicModel({
    topic: 'orders',
    internal: false,
    connectionName: 'Local Kafka',
    readOnly: options.readOnly ?? false,
    session: () => Promise.resolve(session),
    tailFlushMs: 10,
  });
  return { cluster, model, session };
}

describe('KafkaTopicModel: live reading (V13.29)', () => {
  it('shows the messages that arrive, and only those', async () => {
    const { cluster, model } = await setup();
    let changes = 0;
    const started = await model.startTail(0, () => {
      changes += 1;
    });
    expect(started).toMatchObject({ tailing: true, read: true, messages: [], partition: 0 });
    expect(model.tailing).toBe(true);
    await wait(40);
    cluster.append('orders', 0, 'one');
    cluster.append('orders', 0, 'two');
    await wait(80);
    const state = model.state();
    expect(state.messages.map((one) => one.value?.text)).toEqual(['one', 'two']);
    expect(changes).toBeGreaterThan(0);
    model.stopTail();
  });

  it('gathers a burst into one change', async () => {
    const { cluster, model } = await setup();
    let changes = 0;
    await model.startTail(0, () => {
      changes += 1;
    });
    await wait(40);
    for (let i = 0; i < 20; i++) {
      cluster.append('orders', 0, `m${i}`);
    }
    await wait(120);
    expect(model.state().messages).toHaveLength(20);
    expect(changes).toBeLessThanOrEqual(3);
    model.stopTail();
  });

  it('stops: what arrived stays, nothing more is added, and the state says it is not live', async () => {
    const { cluster, model } = await setup();
    await model.startTail(0, () => undefined);
    await wait(40);
    cluster.append('orders', 0, 'seen');
    await wait(80);
    const stopped = model.stopTail();
    expect(stopped.tailing).toBeUndefined();
    expect(model.tailing).toBe(false);
    cluster.append('orders', 0, 'late');
    await wait(80);
    expect(model.state().messages.map((one) => one.value?.text)).toEqual(['seen']);
  });

  it('keeps a message that arrived just before it stopped', async () => {
    const { cluster, model } = await setup();
    await model.startTail(0, () => undefined);
    await wait(40);
    cluster.append('orders', 0, 'last');
    await wait(15);
    // The flush timer may or may not have fired; either way the message is in the state.
    expect(model.stopTail().messages.map((one) => one.value?.text)).toEqual(['last']);
  });

  it('keeps no more than a read brings, dropping the oldest', async () => {
    const { cluster, model } = await setup();
    await model.startTail(0, () => undefined);
    await wait(40);
    for (let i = 0; i < MAX_KAFKA_COUNT + 20; i++) {
      cluster.append('orders', 0, `m${i}`);
    }
    await wait(300);
    const messages = model.stopTail().messages;
    expect(messages).toHaveLength(MAX_KAFKA_COUNT);
    expect(messages.at(-1)?.value?.text).toBe(`m${MAX_KAFKA_COUNT + 19}`);
    expect(messages[0]?.value?.text).toBe('m20');
  });

  it('keeps what was read and goes on after it when the same partition is followed', async () => {
    const { cluster, model } = await setup();
    await model.readMessages({ partition: 0, mode: 'last', count: 5 });
    await model.startTail(0, () => undefined);
    await wait(40);
    cluster.append('orders', 0, 'new');
    await wait(80);
    expect(model.stopTail().messages.map((one) => one.value?.text)).toEqual(['old', 'new']);
  });

  it('starts from an empty list for another partition', async () => {
    const { model } = await setup();
    await model.readMessages({ partition: 0, mode: 'last', count: 5 });
    const state = await model.startTail(1, () => undefined);
    expect(state.messages).toEqual([]);
    expect(state.partition).toBe(1);
    model.stopTail();
  });

  it('is stopped by a read, a deletion and a new tail', async () => {
    const { model, cluster } = await setup();
    await model.startTail(0, () => undefined);
    await model.readMessages({ partition: 0, mode: 'last', count: 5 });
    expect(model.tailing).toBe(false);
    await model.startTail(0, () => undefined);
    const first = cluster.consumers.at(-1);
    await model.startTail(1, () => undefined);
    await wait(20);
    expect(first?.disconnected).toBe(true);
    expect(model.tailing).toBe(true);
    await model.deleteTopic();
    expect(model.tailing).toBe(false);
  });

  it('does not touch a group of the user’s', async () => {
    const { cluster, model } = await setup();
    cluster.commit('billing', 'orders', 0, 0);
    const before = cluster.committedSnapshot();
    await model.startTail(0, () => undefined);
    await wait(40);
    cluster.append('orders', 0, 'x');
    await wait(60);
    model.stopTail();
    expect(cluster.committedSnapshot()).toBe(before);
  });

  it('ends the tail and says why when the broker fails it', async () => {
    const { model, session } = await setup();
    const failing: KafkaSession = Object.assign(Object.create(session) as KafkaSession, {
      watchMessages: () => Promise.reject(new Error('the broker went away')),
    });
    const broken = new KafkaTopicModel({
      topic: 'orders',
      internal: false,
      connectionName: 'x',
      readOnly: false,
      session: () => Promise.resolve(failing),
      tailFlushMs: 10,
    });
    let changes = 0;
    await broken.startTail(0, () => {
      changes += 1;
    });
    await wait(20);
    expect(broken.tailing).toBe(false);
    expect(broken.state().notice).toMatch(/the broker went away/u);
    expect(changes).toBe(1);
    expect(model.tailing).toBe(false);
  });

  it('reports a partition that is not there as the reason the tail ended', async () => {
    const { model } = await setup();
    await model.startTail(9, () => undefined);
    await wait(30);
    expect(model.tailing).toBe(false);
    expect(model.state().notice).toMatch(/partition 9/u);
  });

  it('works on a read-only connection, which it only reads', async () => {
    const { model, cluster } = await setup({ readOnly: true });
    await model.startTail(0, () => undefined);
    await wait(40);
    cluster.append('orders', 0, 'x');
    await wait(60);
    expect(model.stopTail().messages).toHaveLength(1);
  });
});

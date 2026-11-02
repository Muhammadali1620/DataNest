import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { openKafkaSession } from '../../../../src/drivers/kafka/session';
import {
  KafkaTopicModel,
  MAX_SHOWN_BYTES,
  parseMoment,
  viewOf,
} from '../../../../src/vscode/panels/kafka-topic-model';
import { FakeKafka } from '../../../helpers/fake-kafka';

async function setup(readOnly = false) {
  const cluster = new FakeKafka();
  cluster.addTopic('orders', 3);
  for (let i = 0; i < 6; i++) {
    cluster.append('orders', 1, `m${i}`, { key: `k${i}`, at: 1000 * (i + 1) });
  }
  const session = await openKafkaSession(
    { id: 'k', name: 'Kafka', driver: 'kafka', host: 'h' },
    cluster.factory,
  );
  const model = new KafkaTopicModel({
    topic: 'orders',
    internal: false,
    connectionName: 'Local Kafka',
    readOnly,
    session: () => Promise.resolve(session),
  });
  return { cluster, model };
}

describe('KafkaTopicModel', () => {
  it('starts with nothing read', async () => {
    const { model } = await setup();
    expect(model.state()).toMatchObject({
      topic: 'orders',
      internal: false,
      connectionName: 'Local Kafka',
      readOnly: false,
      partitions: [],
      messages: [],
      read: false,
      mode: 'last',
      count: 50,
    });
    expect(model.topic).toBe('orders');
  });

  it('lists the partitions and opens the first one that holds messages', async () => {
    const { model } = await setup();
    const state = await model.refresh();
    expect(state.partitions.map((one) => one.partition)).toEqual([0, 1, 2]);
    expect(state.partitions[1]).toMatchObject({ low: '0', high: '6' });
    expect(state.partition).toBe(1);
  });

  it('keeps the partition the user chose when it lists again', async () => {
    const { model } = await setup();
    await model.refresh();
    await model.readMessages({ partition: 2, mode: 'last', count: 5 });
    const state = await model.refresh();
    expect(state.partition).toBe(2);
  });

  it('reads the last messages', async () => {
    const { model } = await setup();
    const state = await model.readMessages({ partition: 1, mode: 'last', count: 2 });
    expect(state.messages.map((one) => one.offset)).toEqual(['4', '5']);
    expect(state.read).toBe(true);
    expect(state.messages[0]?.value?.text).toBe('m4');
    expect(state.messages[0]?.key?.text).toBe('k4');
    expect(state.notice).toBeUndefined();
  });

  it('reads from an offset and says when fewer were there', async () => {
    const { model } = await setup();
    const state = await model.readMessages({
      partition: 1,
      mode: 'offset',
      count: 10,
      offset: ' 4 ',
    });
    expect(state.messages.map((one) => one.offset)).toEqual(['4', '5']);
    expect(state.notice).toMatch(/Only 2 messages/u);
  });

  it('refuses an offset that is not a number', async () => {
    const { model } = await setup();
    await expect(
      model.readMessages({ partition: 1, mode: 'offset', count: 1, offset: '-1' }),
    ).rejects.toMatchObject({ code: 'syntax' });
    await expect(
      model.readMessages({ partition: 1, mode: 'offset', count: 1 }),
    ).rejects.toMatchObject({ code: 'syntax' });
  });

  it('reads from a moment in time', async () => {
    const { model } = await setup();
    const state = await model.readMessages({
      partition: 1,
      mode: 'time',
      count: 10,
      time: '3500' + '000000',
    });
    // 3 500 000 000 ms is long after the last message (6 000 ms): nothing is there.
    expect(state.messages).toEqual([]);
    expect(state.notice).toMatch(/no message at or after/u);
    const early = await model.readMessages({
      partition: 1,
      mode: 'time',
      count: 2,
      time: String(1_700_000_000_000),
    });
    expect(early.messages).toEqual([]);
  });

  it('finds the first message at a moment that falls among them', async () => {
    const { cluster } = await setup();
    cluster.addTopic('timed', 1);
    cluster.append('timed', 0, 'a', { at: 1_000_000_000_000 });
    cluster.append('timed', 0, 'b', { at: 1_000_000_005_000 });
    cluster.append('timed', 0, 'c', { at: 1_000_000_009_000 });
    const timed = new KafkaTopicModel({
      topic: 'timed',
      internal: false,
      connectionName: 'x',
      readOnly: false,
      session: () =>
        openKafkaSession({ id: 'k', name: 'K', driver: 'kafka', host: 'h' }, cluster.factory),
    });
    const state = await timed.readMessages({
      partition: 0,
      mode: 'time',
      count: 5,
      time: '1000000004000',
    });
    expect(state.messages.map((one) => one.value?.text)).toEqual(['b', 'c']);
  });

  it('refuses a moment that is not a time', async () => {
    const { model } = await setup();
    await expect(
      model.readMessages({ partition: 1, mode: 'time', count: 1, time: 'soon' }),
    ).rejects.toMatchObject({ code: 'syntax' });
  });

  it('says an empty partition is empty', async () => {
    const { model } = await setup();
    const state = await model.readMessages({ partition: 0, mode: 'last', count: 5 });
    expect(state.messages).toEqual([]);
    expect(state.notice).toMatch(/no messages/u);
  });

  it('keeps the count within what the page may ask', async () => {
    const { model } = await setup();
    const state = await model.readMessages({ partition: 1, mode: 'last', count: 99_999 });
    expect(state.count).toBe(500);
    expect(state.messages).toHaveLength(6);
    const low = await model.readMessages({ partition: 1, mode: 'last', count: 0 });
    expect(low.count).toBe(1);
  });

  it('sends a message and lists the partitions again', async () => {
    const { cluster, model } = await setup();
    const result = await model.produce({
      partition: 2,
      key: { text: 'id-1' },
      value: { text: '{"a":1}' },
      headers: [
        { name: ' trace ', value: '42' },
        { name: '  ', value: 'dropped' },
      ],
    });
    expect(result).toMatchObject({ partition: 2, offset: '0' });
    expect(result.state.partitions[2]).toMatchObject({ high: '1' });
    const sent = cluster.sent[0]?.messages[0] as { headers: Record<string, Buffer> };
    expect(Object.keys(sent.headers)).toEqual(['trace']);
  });

  it('sends hexadecimal bytes as they are and a tombstone as nothing', async () => {
    const { cluster, model } = await setup();
    await model.produce({ value: { text: '', hex: '00ff10' }, headers: [] });
    await model.produce({ value: null, key: { text: '' }, headers: [] });
    const first = cluster.sent[0]?.messages[0] as { value: Buffer };
    expect([...first.value]).toEqual([0, 255, 16]);
    const second = cluster.sent[1]?.messages[0] as { value: unknown; key: unknown };
    expect(second.value).toBeNull();
    // An empty key is no key.
    expect(second.key).toBeNull();
  });

  it('refuses hexadecimal text that is not hexadecimal', async () => {
    const { model } = await setup();
    await expect(
      model.produce({ value: { text: '', hex: 'zz' }, headers: [] }),
    ).rejects.toMatchObject({ code: 'syntax' });
  });

  it('changes nothing on a read-only connection', async () => {
    const { cluster, model } = await setup(true);
    await expect(model.produce({ value: { text: 'x' }, headers: [] })).rejects.toBeInstanceOf(
      DbError,
    );
    await expect(model.deleteTopic()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(cluster.sent).toEqual([]);
    expect(cluster.topics.has('orders')).toBe(true);
  });

  it('deletes the topic', async () => {
    const { cluster, model } = await setup();
    await model.deleteTopic();
    expect(cluster.topics.has('orders')).toBe(false);
  });
});

describe('parseMoment', () => {
  it('reads milliseconds and dates', () => {
    expect(parseMoment(' 1700000000000 ')).toBe(1_700_000_000_000);
    expect(parseMoment('2026-11-01T12:00:00Z')).toBe(Date.UTC(2026, 10, 1, 12));
  });

  it('refuses text that is neither', () => {
    expect(() => parseMoment('')).toThrow(DbError);
    expect(() => parseMoment('tomorrow')).toThrow(DbError);
  });
});

describe('viewOf', () => {
  it('shows keys, values and headers as the page does, and cuts the big ones', () => {
    const big = Buffer.alloc(MAX_SHOWN_BYTES + 10, 97);
    const view = viewOf({
      partition: 1,
      offset: '7',
      timestamp: '5',
      key: null,
      value: big,
      headers: [{ name: 'h', value: Buffer.from([0xff, 0x00]) }],
    });
    expect(view.key).toBeNull();
    expect(view.value).toMatchObject({ truncated: true, size: MAX_SHOWN_BYTES + 10 });
    expect(view.headers[0]?.value.hex).toBe('ff00');
    expect(view).not.toHaveProperty('schema');
  });

  it('says which registry schema a message was decoded with (V13.34)', () => {
    const view = viewOf({
      partition: 0,
      offset: '1',
      timestamp: '5',
      key: null,
      value: Buffer.from('{"a":1}'),
      headers: [],
      schema: { id: 4, format: 'AVRO' },
    });
    expect(view.schema).toEqual({ id: 4, format: 'AVRO' });
  });
});

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { MAX_RABBIT_PEEK } from '../../../../src/shared/protocols/rabbitmq-object';
import {
  MAX_BINDINGS,
  MAX_PEEK_BYTES,
  MAX_SHOWN_BYTES,
  messageViewOf,
  RabbitObjectModel,
  type RabbitObjectModelDeps,
} from '../../../../src/vscode/panels/rabbitmq-object-model';
import { FakeRabbitSession } from '../../../helpers/fake-rabbitmq';

function setup(
  options: Partial<RabbitObjectModelDeps> = {},
  messages: string[] = ['one', 'two', 'three'],
) {
  const session = new FakeRabbitSession();
  session.broker.addQueue({
    vhost: '/',
    name: 'orders',
    type: 'quorum',
    consumers: 2,
    policy: 'ha',
    arguments: { 'x-max-length': 100, 'x-queue-type': 'quorum' },
    messages,
  });
  session.broker.exchanges.push({ vhost: '/', name: 'events', type: 'topic' });
  session.broker.bindings.push({
    vhost: '/',
    source: 'events',
    destination: 'orders',
    destinationType: 'queue',
    routingKey: 'order.#',
  });
  const queue = new RabbitObjectModel({
    kind: 'queue',
    vhost: '/',
    name: 'orders',
    connectionName: 'Broker',
    readOnly: false,
    session: () => Promise.resolve(session),
    ...options,
  });
  const exchange = new RabbitObjectModel({
    kind: 'exchange',
    vhost: '/',
    name: 'events',
    connectionName: 'Broker',
    readOnly: false,
    session: () => Promise.resolve(session),
  });
  return { session, queue, exchange };
}

describe('RabbitObjectModel (V13.26)', () => {
  describe('a queue', () => {
    it('reads its figures, facts, arguments and bindings', async () => {
      const { queue } = setup();
      const state = await queue.refresh();
      expect(state).toMatchObject({
        kind: 'queue',
        vhost: '/',
        name: 'orders',
        connectionName: 'Broker',
        readOnly: false,
        type: 'quorum',
        state: 'running',
        ready: 3,
        unacked: 0,
        total: 3,
        consumers: 2,
        peeked: false,
        messages: [],
        bindingsCut: false,
      });
      const facts = Object.fromEntries(state.facts.map((fact) => [fact.key, fact.value]));
      expect(facts).toMatchObject({
        Type: 'quorum',
        Durable: 'yes',
        'Auto-delete': 'no',
        Exclusive: 'no',
        Consumers: '2',
        Policy: 'ha',
        Node: 'rabbit@fake',
        'Published per second': '1.5',
      });
      expect(facts.Memory).toBeTruthy();
      expect(state.arguments).toEqual([
        { key: 'x-max-length', value: '100' },
        { key: 'x-queue-type', value: 'quorum' },
      ]);
      expect(state.bindings).toEqual([
        {
          source: 'events',
          destination: 'orders',
          destinationType: 'queue',
          routingKey: 'order.#',
          arguments: '',
        },
      ]);
    });

    it('calls a queue of no named type classic', async () => {
      const { session } = setup();
      session.broker.addQueue({ vhost: '/', name: 'plain' });
      const model = new RabbitObjectModel({
        kind: 'queue',
        vhost: '/',
        name: 'plain',
        connectionName: 'B',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      expect((await model.refresh()).type).toBe('classic');
    });

    it('lists no more than it can show and says there are more', async () => {
      const { session, queue } = setup();
      for (let index = 0; index < MAX_BINDINGS + 5; index += 1) {
        session.broker.bindings.push({
          vhost: '/',
          source: 'events',
          destination: 'orders',
          destinationType: 'queue',
          routingKey: `k${index}`,
          arguments: { index },
        });
      }
      const state = await queue.refresh();
      expect(state.bindings).toHaveLength(MAX_BINDINGS);
      expect(state.bindingsCut).toBe(true);
      expect(state.bindings[1]?.arguments).toContain('"index"');
    });

    it('fails with the broker’s own error when the queue is not there', async () => {
      const { session } = setup();
      const gone = new RabbitObjectModel({
        kind: 'queue',
        vhost: '/',
        name: 'gone',
        connectionName: 'B',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      await expect(gone.refresh()).rejects.toMatchObject({ code: 'not-found' });
    });

    it('peeks at the first messages and leaves them all in the queue', async () => {
      const { session, queue } = setup();
      await queue.refresh();
      const state = await queue.peek(2);
      expect(state.peeked).toBe(true);
      expect(state.count).toBe(2);
      expect(state.messages.map((message) => message.payload.text)).toEqual(['one', 'two']);
      // The first look finds them fresh and puts them back marked: the next look shows it.
      expect(state.messages.every((message) => !message.redelivered)).toBe(true);
      const again = await queue.peek(3);
      expect(again.messages.map((message) => message.redelivered)).toEqual([true, true, false]);
      expect(state.messages[0]).toMatchObject({
        routingKey: 'orders',
        messagesLeft: 2,
        payloadBytes: 3,
      });
      expect(state.notice).toBeUndefined();
      // Nothing was taken.
      expect(session.broker.queue('/', 'orders')?.messages).toHaveLength(3);
      expect(state.ready).toBe(3);
    });

    it('bounds what a peek asks for, in count and in bytes', async () => {
      const { session, queue } = setup();
      const asked: unknown[] = [];
      const original = session.peekMessages.bind(session);
      session.peekMessages = (request) => {
        asked.push(request);
        return original(request);
      };
      await queue.peek(5000);
      await queue.peek(0);
      expect(asked).toMatchObject([
        { count: MAX_RABBIT_PEEK, maxBytes: MAX_SHOWN_BYTES, vhost: '/', queue: 'orders' },
        { count: 1 },
      ]);
      expect(MAX_PEEK_BYTES).toBeGreaterThan(MAX_SHOWN_BYTES);
    });

    it('says so when the queue is empty or holds fewer than asked', async () => {
      const empty = setup({}, []);
      expect((await empty.queue.peek(5)).notice).toBe('The queue holds no messages');
      const few = setup({}, ['a', 'b']);
      expect((await few.queue.peek(5)).notice).toBe('Only 2 messages were there to look at');
    });

    it('cuts a long payload and keeps its real length', async () => {
      const long = 'x'.repeat(MAX_SHOWN_BYTES + 10);
      const { queue } = setup({}, [long]);
      const [message] = (await queue.peek(1)).messages;
      expect(message?.payloadBytes).toBe(long.length);
      expect(message?.payload.truncated).toBe(true);
      expect(message?.payload.size).toBe(long.length);
    });

    it('shows binary payloads as hexadecimal text and keeps the properties', async () => {
      const { session, queue } = setup({}, []);
      session.broker.queue('/', 'orders')?.messages.push({
        payload: Buffer.from([0, 255, 1]),
        properties: { content_type: 'application/octet-stream' },
      });
      const [message] = (await queue.peek(1)).messages;
      expect(message?.payload.hex).toBe('00ff01');
      expect(JSON.parse(message?.properties ?? '{}')).toEqual({
        content_type: 'application/octet-stream',
      });
    });

    it('keeps what was peeked when the figures are read again', async () => {
      const { queue } = setup();
      await queue.peek(1);
      const state = await queue.refresh();
      expect(state.messages).toHaveLength(1);
      expect(state.peeked).toBe(true);
    });

    it('purges the queue and forgets the peeked messages', async () => {
      const { session, queue } = setup();
      await queue.peek(2);
      await queue.purge();
      expect(session.broker.queue('/', 'orders')?.messages).toHaveLength(0);
      const state = queue.state();
      expect(state).toMatchObject({ peeked: false, messages: [], ready: 0 });
    });

    it('deletes the queue', async () => {
      const { session, queue } = setup();
      await queue.deleteObject();
      expect(session.broker.queue('/', 'orders')).toBeUndefined();
    });
  });

  describe('publishing', () => {
    it('sends to the queue through the default exchange, by its name', async () => {
      const { session, queue } = setup();
      const { routed, state } = await queue.publish({
        routingKey: 'ignored',
        payload: { text: 'hello' },
        contentType: ' text/plain ',
        persistent: true,
        headers: [
          { name: ' trace ', value: '42' },
          { name: ' ', value: 'skipped' },
        ],
      });
      expect(routed).toBe(true);
      expect(session.published[0]).toMatchObject({
        vhost: '/',
        exchange: '',
        routingKey: 'orders',
        properties: {
          delivery_mode: 2,
          content_type: 'text/plain',
          headers: { trace: '42' },
        },
      });
      expect(Buffer.from(session.published[0]?.payload ?? []).toString()).toBe('hello');
      expect(state.ready).toBe(4);
    });

    it('marks a message not persistent and leaves out empty properties', async () => {
      const { session, queue } = setup();
      await queue.publish({
        routingKey: '',
        payload: { text: 'x' },
        persistent: false,
        headers: [],
      });
      expect(session.published[0]?.properties).toEqual({ delivery_mode: 1 });
    });

    it('sends to an exchange with the routing key it was given', async () => {
      const { session, exchange } = setup();
      const { routed } = await exchange.publish({
        routingKey: 'order.created',
        payload: { text: '{}' },
        persistent: true,
        headers: [],
      });
      expect(routed).toBe(false);
      expect(session.published[0]).toMatchObject({
        exchange: 'events',
        routingKey: 'order.created',
      });
    });

    it('sends hexadecimal text as the bytes it stands for', async () => {
      const { session, queue } = setup();
      await queue.publish({
        routingKey: '',
        payload: { text: '', hex: '00ff10' },
        persistent: true,
        headers: [],
      });
      expect([...(session.published[0]?.payload ?? [])]).toEqual([0, 255, 16]);
    });

    it('refuses hexadecimal text that is not valid', async () => {
      const { queue } = setup();
      await expect(
        queue.publish({
          routingKey: '',
          payload: { text: '', hex: 'zz' },
          persistent: true,
          headers: [],
        }),
      ).rejects.toMatchObject({ code: 'syntax' });
    });
  });

  describe('an exchange', () => {
    it('reads its facts and the bindings in both directions', async () => {
      const { exchange } = setup();
      const state = await exchange.refresh();
      expect(state).toMatchObject({ kind: 'exchange', type: 'topic', name: 'events', ready: 0 });
      expect(state.facts.map((fact) => fact.key)).toEqual([
        'Type',
        'Durable',
        'Auto-delete',
        'Internal',
      ]);
      expect(state.bindings.map((binding) => binding.destination)).toEqual(['orders']);
    });

    it('lists the policy when it has one', async () => {
      const { session } = setup();
      session.getExchange = () =>
        Promise.resolve({
          vhost: '/',
          name: 'x',
          type: 'fanout',
          durable: false,
          autoDelete: true,
          internal: true,
          policy: 'p',
          arguments: {},
        });
      const model = new RabbitObjectModel({
        kind: 'exchange',
        vhost: '/',
        name: 'x',
        connectionName: 'B',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      const facts = Object.fromEntries((await model.refresh()).facts.map((f) => [f.key, f.value]));
      expect(facts).toMatchObject({
        Durable: 'no',
        'Auto-delete': 'yes',
        Internal: 'yes',
        Policy: 'p',
      });
    });

    it('has no messages to look at or to remove', async () => {
      const { exchange } = setup();
      await expect(exchange.peek(1)).rejects.toMatchObject({ code: 'unsupported' });
      await expect(exchange.purge()).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('deletes an exchange of the user’s, never one of the broker’s', async () => {
      const { session, exchange } = setup();
      await exchange.deleteObject();
      expect(session.broker.exchanges.some((one) => one.name === 'events')).toBe(false);
      for (const name of ['', 'amq.direct']) {
        const own = new RabbitObjectModel({
          kind: 'exchange',
          vhost: '/',
          name,
          connectionName: 'B',
          readOnly: false,
          session: () => Promise.resolve(session),
        });
        await expect(own.deleteObject()).rejects.toMatchObject({ code: 'unsupported' });
      }
    });
  });

  describe('on a read-only connection', () => {
    it('reads and peeks, but changes nothing', async () => {
      const { session, queue } = setup({ readOnly: true });
      expect((await queue.refresh()).readOnly).toBe(true);
      expect((await queue.peek(1)).messages).toHaveLength(1);
      for (const change of [
        () =>
          queue.publish({ routingKey: '', payload: { text: 'x' }, persistent: true, headers: [] }),
        () => queue.purge(),
        () => queue.deleteObject(),
      ]) {
        await expect(change()).rejects.toBeInstanceOf(DbError);
        await expect(change()).rejects.toMatchObject({ code: 'permission-denied' });
      }
      expect(session.calls).not.toContain('publish');
      expect(session.calls).not.toContain('purgeQueue');
      expect(session.calls).not.toContain('deleteQueue');
    });
  });

  it('names its object', () => {
    const { queue, exchange } = setup();
    expect([queue.kind, queue.vhost, queue.name]).toEqual(['queue', '/', 'orders']);
    expect(exchange.kind).toBe('exchange');
  });

  it('shows a payload of a message as the page does', () => {
    const view = messageViewOf({
      payload: new TextEncoder().encode('héllo'),
      payloadBytes: 6,
      redelivered: false,
      exchange: 'x',
      routingKey: 'k',
      messagesLeft: 0,
      properties: {},
    });
    expect(view.payload.text).toBe('héllo');
    expect(view.properties).toBe('{}');
  });
});

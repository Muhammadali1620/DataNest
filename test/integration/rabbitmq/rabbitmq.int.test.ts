import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/rabbitmq';
import type { RabbitSession } from '../../../src/drivers/rabbitmq-driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { RabbitObjectModel } from '../../../src/vscode/panels/rabbitmq-object-model';
import { TEST_RABBITMQ } from '../../helpers/rabbitmq-servers';

// docker/compose.yml `rabbitmq` (V13.26): one node with the management plugin on 7156.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'test-rabbit',
    name: 'RabbitMQ',
    driver: 'rabbitmq',
    host: TEST_RABBITMQ.host,
    port: TEST_RABBITMQ.port,
    user: TEST_RABBITMQ.user,
    password: TEST_RABBITMQ.password,
    ...overrides,
  };
}

const unique = (name: string): string => `dn-it-${name}-${randomUUID().slice(0, 8)}`;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The broker's own HTTP API, to play the part of another application. */
async function outside(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://${TEST_RABBITMQ.host}:${TEST_RABBITMQ.port}/api/${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${TEST_RABBITMQ.user}:${TEST_RABBITMQ.password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  }
  const answer = await response.text();
  return answer === '' ? undefined : (JSON.parse(answer) as unknown);
}

/** The broker counts messages every few seconds; wait until its figures catch up. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('RabbitMQ (V13.26)', () => {
  let session: RabbitSession;
  const queues: string[] = [];
  const exchanges: string[] = [];

  async function queue(name: string): Promise<string> {
    const full = unique(name);
    await session.declareQueue({ vhost: '/', name: full, durable: false, autoDelete: false });
    queues.push(full);
    return full;
  }

  async function publish(name: string, ...bodies: string[]): Promise<void> {
    for (const body of bodies) {
      const routed = await session.publish({
        vhost: '/',
        exchange: '',
        routingKey: name,
        payload: new TextEncoder().encode(body),
        properties: { content_type: 'text/plain', headers: { source: 'it' } },
      });
      expect(routed).toBe(true);
    }
  }

  beforeAll(async () => {
    session = await driver.openSession(config());
  }, 60_000);

  afterAll(async () => {
    for (const name of queues) {
      await session.deleteQueue('/', name).catch(() => undefined);
    }
    for (const name of exchanges) {
      await session.deleteExchange('/', name).catch(() => undefined);
    }
    await session.close();
  });

  it('says who the broker is and who we are', () => {
    expect(session.server.version).toMatch(/^\d+\.\d+/u);
    expect(session.server.user).toBe(TEST_RABBITMQ.user);
    expect(session.server.clusterName).not.toBe('');
  });

  it('refuses a wrong password', async () => {
    await expect(driver.openSession(config({ password: 'nope' }))).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('refuses a port where nobody listens', async () => {
    await expect(driver.openSession(config({ port: 7157 }))).rejects.toMatchObject({
      code: 'connection-failed',
    });
  });

  it('lists the default virtual host, or only the one the connection names', async () => {
    expect((await session.listVhosts()).map((vhost) => vhost.name)).toContain('/');
    const one = await driver.openSession(config({ database: '/' }));
    expect((await one.listVhosts()).map((vhost) => vhost.name)).toEqual(['/']);
    await one.close();
  });

  it('declares a queue and finds it, with its figures, in the listing and by name', async () => {
    const name = await queue('declared');
    const page = await session.listQueues('/');
    expect(page.items.map((one) => one.name)).toContain(name);
    const info = await session.getQueue('/', name);
    expect(info).toMatchObject({
      vhost: '/',
      name,
      durable: false,
      autoDelete: false,
      exclusive: false,
    });
  });

  it('declares queues of the other types', async () => {
    const name = unique('quorum');
    await session.declareQueue({
      vhost: '/',
      name,
      type: 'quorum',
      durable: true,
      autoDelete: false,
    });
    queues.push(name);
    expect((await session.getQueue('/', name)).type).toBe('quorum');
  });

  it('publishes through the default exchange and says whether a queue took the message', async () => {
    const name = await queue('routed');
    await publish(name, 'one');
    const lost = await session.publish({
      vhost: '/',
      exchange: '',
      routingKey: unique('nobody'),
      payload: new Uint8Array(),
    });
    expect(lost).toBe(false);
  });

  it('peeks at the first messages in order and leaves every one of them in the queue', async () => {
    const name = await queue('peeked');
    await publish(name, 'one', 'two', 'three');
    const first = await session.peekMessages({ vhost: '/', queue: name, count: 2, maxBytes: 100 });
    expect(first.map((message) => text(message.payload))).toEqual(['one', 'two']);
    // The flag tells what the broker knew when it handed the message out: the first look
    // finds them fresh, and puts them back marked.
    expect(first.every((message) => !message.redelivered)).toBe(true);
    expect(first[0]).toMatchObject({ exchange: '', routingKey: name, payloadBytes: 3 });
    expect(first[0]?.properties).toMatchObject({
      content_type: 'text/plain',
      headers: { source: 'it' },
    });
    // The queue still holds all three, and a second look sees them again, in the same order.
    const second = await session.peekMessages({
      vhost: '/',
      queue: name,
      count: 10,
      maxBytes: 100,
    });
    expect(second.map((message) => text(message.payload))).toEqual(['one', 'two', 'three']);
    expect(second.map((message) => message.redelivered)).toEqual([true, true, false]);
    const counted = await until(
      () => session.getQueue('/', name),
      (info) => info.ready === 3,
    );
    expect(counted.ready).toBe(3);
    expect(counted.unacked).toBe(0);
    // Nothing is out for delivery either: a consumer of ours would still get message one first.
    const third = await session.peekMessages({ vhost: '/', queue: name, count: 1, maxBytes: 100 });
    expect(text(third[0]?.payload ?? new Uint8Array())).toBe('one');
  });

  it('cuts a long payload and keeps its full length', async () => {
    const name = await queue('long');
    await publish(name, '0123456789');
    const [message] = await session.peekMessages({
      vhost: '/',
      queue: name,
      count: 1,
      maxBytes: 4,
    });
    expect(text(message?.payload ?? new Uint8Array())).toBe('0123');
    expect(message?.payloadBytes).toBe(10);
  });

  it('brings binary payloads back byte for byte', async () => {
    const name = await queue('binary');
    const bytes = Uint8Array.from([0, 255, 128, 10, 13, 200]);
    await session.publish({ vhost: '/', exchange: '', routingKey: name, payload: bytes });
    const [message] = await session.peekMessages({
      vhost: '/',
      queue: name,
      count: 1,
      maxBytes: 100,
    });
    expect([...(message?.payload ?? [])]).toEqual([...bytes]);
  });

  it('peeks at nothing in an empty queue and fails for a queue that is not there', async () => {
    const name = await queue('empty');
    expect(await session.peekMessages({ vhost: '/', queue: name, count: 5, maxBytes: 10 })).toEqual(
      [],
    );
    await expect(
      session.peekMessages({ vhost: '/', queue: unique('gone'), count: 1, maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('purges a queue', async () => {
    const name = await queue('purged');
    await publish(name, 'a', 'b');
    await session.purgeQueue('/', name);
    expect(await session.peekMessages({ vhost: '/', queue: name, count: 5, maxBytes: 10 })).toEqual(
      [],
    );
  });

  it('deletes a queue, and says so when it is not there', async () => {
    const name = await queue('deleted');
    await session.deleteQueue('/', name);
    await expect(session.getQueue('/', name)).rejects.toMatchObject({ code: 'not-found' });
    await expect(session.deleteQueue('/', name)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('declares an exchange, lists the bindings on both sides and routes through them', async () => {
    const exchange = unique('events');
    const target = await queue('bound');
    await session.declareExchange({
      vhost: '/',
      name: exchange,
      type: 'topic',
      durable: false,
      autoDelete: false,
      internal: false,
    });
    exchanges.push(exchange);
    expect(await session.getExchange('/', exchange)).toMatchObject({
      name: exchange,
      type: 'topic',
      durable: false,
      internal: false,
    });
    expect((await session.listExchanges('/')).items.map((one) => one.name)).toContain(exchange);
    // Without a binding nothing takes the message.
    expect(
      await session.publish({
        vhost: '/',
        exchange,
        routingKey: 'order.created',
        payload: new Uint8Array(),
      }),
    ).toBe(false);
    await outside('POST', `bindings/%2F/e/${exchange}/q/${target}`, { routing_key: 'order.*' });
    // Every queue is also bound to the default exchange under its own name.
    expect(await session.listBindings('/', { queue: target })).toEqual([
      {
        source: '',
        destination: target,
        destinationType: 'queue',
        routingKey: target,
        arguments: {},
      },
      {
        source: exchange,
        destination: target,
        destinationType: 'queue',
        routingKey: 'order.*',
        arguments: {},
      },
    ]);
    const onExchange = await session.listBindings('/', { exchange });
    expect(onExchange.map((binding) => binding.destination)).toEqual([target]);
    expect(
      await session.publish({
        vhost: '/',
        exchange,
        routingKey: 'order.created',
        payload: new TextEncoder().encode('routed'),
      }),
    ).toBe(true);
    const [message] = await session.peekMessages({
      vhost: '/',
      queue: target,
      count: 1,
      maxBytes: 100,
    });
    expect(text(message?.payload ?? new Uint8Array())).toBe('routed');
    expect(message?.exchange).toBe(exchange);
    expect(message?.routingKey).toBe('order.created');
  });

  it('reads the default exchange as the broker names it', async () => {
    const info = await session.getExchange('/', '');
    expect(info).toMatchObject({ name: '', type: 'direct' });
  });

  it('deletes an exchange', async () => {
    const exchange = unique('doomed');
    await session.declareExchange({
      vhost: '/',
      name: exchange,
      type: 'fanout',
      durable: false,
      autoDelete: false,
      internal: false,
    });
    await session.deleteExchange('/', exchange);
    await expect(session.getExchange('/', exchange)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses to redeclare a queue with other settings, with the broker’s reason', async () => {
    const name = await queue('fixed');
    const error = await session
      .declareQueue({ vhost: '/', name, durable: true, autoDelete: false })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: expect.stringMatching(/constraint|syntax/u) as unknown });
    expect((error as Error).message).toMatch(/PRECONDITION_FAILED|inequivalent/iu);
  });

  it('handles a name with a slash and a space', async () => {
    const name = `${unique('odd')}/with space`;
    await session.declareQueue({ vhost: '/', name, durable: false, autoDelete: false });
    queues.push(name);
    expect((await session.getQueue('/', name)).name).toBe(name);
    await publish(name, 'x');
    const [message] = await session.peekMessages({
      vhost: '/',
      queue: name,
      count: 1,
      maxBytes: 10,
    });
    expect(text(message?.payload ?? new Uint8Array())).toBe('x');
  });

  it('can be cancelled while it waits for the broker', async () => {
    const name = await queue('cancelled');
    await publish(name, 'x');
    const abort = new AbortController();
    abort.abort();
    await expect(
      session.peekMessages({
        vhost: '/',
        queue: name,
        count: 1,
        maxBytes: 10,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('shows a queue on the page: figures, bindings, a peek, a publish and a purge', async () => {
    const name = await queue('page');
    await publish(name, 'first');
    const model = new RabbitObjectModel({
      kind: 'queue',
      vhost: '/',
      name,
      connectionName: 'RabbitMQ',
      readOnly: false,
      session: () => Promise.resolve(session),
    });
    expect((await model.refresh()).kind).toBe('queue');
    const peeked = await model.peek(5);
    expect(peeked.messages.map((message) => message.payload.text)).toEqual(['first']);
    const { routed, state } = await model.publish({
      routingKey: '',
      payload: { text: 'second' },
      contentType: 'text/plain',
      persistent: false,
      headers: [{ name: 'k', value: 'v' }],
    });
    expect(routed).toBe(true);
    expect(state.messages).toHaveLength(1);
    const again = await model.peek(5);
    expect(again.messages.map((message) => message.payload.text)).toEqual(['first', 'second']);
    await model.purge();
    expect((await model.peek(5)).messages).toEqual([]);
  });
});

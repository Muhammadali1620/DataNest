// The RabbitMQ session against the in-memory management API served over real HTTP: what
// it sends, how it reads the answers, and above all that a peek never takes a message.

import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  bindingOf,
  connectionOf,
  exchangeOf,
  openRabbitSession,
  PAGE_SIZE,
  policyOf,
  queueOf,
  rabbitTarget,
  tagsOf,
} from '../../../../src/drivers/rabbitmq/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeRabbitServer } from '../../../helpers/fake-rabbitmq';
import { ROOT } from '../../../helpers/repo';

const servers: FakeRabbitServer[] = [];

async function start(): Promise<{ server: FakeRabbitServer; port: number }> {
  const server = new FakeRabbitServer();
  servers.push(server);
  return { server, port: await server.start() };
}

function config(
  port: number,
  overrides: Partial<ResolvedConnectionConfig> = {},
): ResolvedConnectionConfig {
  return {
    id: 't',
    name: 't',
    driver: 'rabbitmq',
    host: '127.0.0.1',
    port,
    user: 'guest',
    password: 'guest',
    options: { connectTimeout: 2 },
    ...overrides,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
});

async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error('It did not fail');
}

describe('RabbitMQ session over HTTP (V13.26)', () => {
  it('asks who the broker is and who we are when it opens', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    expect(session.server).toEqual({
      version: '3.13.7',
      clusterName: 'rabbit@fake',
      user: 'guest',
    });
    expect(server.requests.map((request) => request.path)).toEqual([
      '/api/overview',
      '/api/whoami',
    ]);
    expect(server.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from('guest:guest').toString('base64')}`,
    );
    await session.close();
  });

  it('signs in as guest when the connection names no user', async () => {
    const { port } = await start();
    const session = await openRabbitSession(config(port, { user: '' }));
    expect(session.server.user).toBe('guest');
    await session.close();
  });

  it('refuses a wrong password and says so', async () => {
    const { port } = await start();
    const error = await failure(openRabbitSession(config(port, { password: 'nope' })));
    expect(error.code).toBe('auth-failed');
    expect(error.message).toContain('Login failed');
  });

  it('refuses a server that is not RabbitMQ', async () => {
    const { server, port } = await start();
    server.failWith = { status: 200, body: '{"something":"else"}' };
    const error = await failure(openRabbitSession(config(port)));
    expect(error.code).toBe('connection-failed');
    expect(error.message).toContain('no version');
  });

  it('says a page that is not JSON is not RabbitMQ', async () => {
    const { server, port } = await start();
    server.failWith = { status: 200, body: '<html>proxy</html>' };
    const error = await failure(openRabbitSession(config(port)));
    expect(error.code).toBe('connection-failed');
    expect(error.message).toContain('did not answer as RabbitMQ');
  });

  it('reports a refused connection as a failed connection', async () => {
    const { server, port } = await start();
    await server.stop();
    servers.length = 0;
    const error = await failure(openRabbitSession(config(port)));
    expect(error.code).toBe('connection-failed');
  });

  it('lists virtual hosts, sorted, or only the one the connection names', async () => {
    const { server, port } = await start();
    server.broker.vhosts.add('app');
    server.broker.vhosts.add('billing');
    const all = await openRabbitSession(config(port));
    expect((await all.listVhosts()).map((vhost) => vhost.name)).toEqual(['/', 'app', 'billing']);
    await all.close();
    const one = await openRabbitSession(config(port, { database: 'app' }));
    expect((await one.listVhosts()).map((vhost) => vhost.name)).toEqual(['app']);
    expect(server.requests.at(-1)?.path).toBe('/api/vhosts/app');
    await one.close();
    const missing = await openRabbitSession(config(port, { database: 'nope' }));
    expect((await failure(missing.listVhosts())).code).toBe('not-found');
    await missing.close();
  });

  it('encodes the default virtual host and names with slashes in the path', async () => {
    const { server, port } = await start();
    server.broker.addQueue({ vhost: '/', name: 'a/b c' });
    const session = await openRabbitSession(config(port));
    const queue = await session.getQueue('/', 'a/b c');
    expect(queue.name).toBe('a/b c');
    expect(server.requests.at(-1)?.path).toBe('/api/queues/%2F/a%2Fb%20c');
    await session.close();
  });

  it('lists queues a page at a time and counts what it did not read', async () => {
    const { server, port } = await start();
    server.broker.addQueue({ vhost: '/', name: 'orders', messages: ['a', 'b'], consumers: 2 });
    server.broker.extraTotal = 40;
    const session = await openRabbitSession(config(port));
    const page = await session.listQueues('/');
    expect(server.requests.at(-1)?.path).toBe(
      `/api/queues/%2F?page=1&page_size=${PAGE_SIZE}&sort=name`,
    );
    expect(page.total).toBe(41);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      name: 'orders',
      vhost: '/',
      ready: 2,
      unacked: 0,
      total: 2,
      consumers: 2,
      state: 'running',
      durable: true,
      incomingRate: 1.5,
      memory: 12_345,
      node: 'rabbit@fake',
    });
    await session.close();
  });

  it('reads a plain array too, as an old broker sends it', async () => {
    const { server, port } = await start();
    server.broker.addQueue({ vhost: '/', name: 'q' });
    const session = await openRabbitSession(config(port));
    // Without `page` the fake answers with an array; the session asks with it, so ask by hand.
    const raw = (await (
      session as unknown as {
        call(method: string, path: string): Promise<unknown>;
      }
    ).call('GET', 'queues/%2F')) as unknown[];
    expect(Array.isArray(raw)).toBe(true);
    await session.close();
  });

  it('lists exchanges and reads one, the default exchange as amq.default', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    const page = await session.listExchanges('/');
    expect(page.items.map((exchange) => exchange.name)).toEqual(['', 'amq.direct', 'amq.topic']);
    const topic = await session.getExchange('/', 'amq.topic');
    expect(topic).toMatchObject({ type: 'topic', durable: true, internal: false });
    await session.getExchange('/', '');
    expect(server.requests.at(-1)?.path).toBe('/api/exchanges/%2F/amq.default');
    await session.close();
  });

  it('lists the bindings of a queue, and both sides of an exchange', async () => {
    const { server, port } = await start();
    server.broker.addQueue({ vhost: '/', name: 'orders' });
    server.broker.bindings.push(
      {
        vhost: '/',
        source: 'amq.topic',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'order.*',
      },
      {
        vhost: '/',
        source: 'amq.direct',
        destination: 'amq.topic',
        destinationType: 'exchange',
        routingKey: '',
      },
    );
    const session = await openRabbitSession(config(port));
    expect(await session.listBindings('/', { queue: 'orders' })).toEqual([
      {
        source: 'amq.topic',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'order.*',
        arguments: {},
        propertiesKey: 'order.*',
      },
    ]);
    const exchange = await session.listBindings('/', { exchange: 'amq.topic' });
    expect(exchange.map((binding) => `${binding.source}>${binding.destination}`)).toEqual([
      'amq.topic>orders',
      'amq.direct>amq.topic',
    ]);
    await session.close();
  });

  describe('peeking', () => {
    it('asks for the requeueing mode, in base64, with the bounds it was given', async () => {
      const { server, port } = await start();
      server.broker.addQueue({ vhost: '/', name: 'q', messages: ['one', 'two', 'three'] });
      const session = await openRabbitSession(config(port));
      await session.peekMessages({ vhost: '/', queue: 'q', count: 2, maxBytes: 1000 });
      const request = server.requests.at(-1);
      expect(request?.method).toBe('POST');
      expect(request?.path).toBe('/api/queues/%2F/q/get');
      expect(request?.body).toEqual({
        count: 2,
        ackmode: 'ack_requeue_true',
        encoding: 'base64',
        truncate: 1000,
      });
      await session.close();
    });

    it('brings the first messages and leaves every one of them in the queue', async () => {
      const { server, port } = await start();
      const queue = server.broker.addQueue({
        vhost: '/',
        name: 'q',
        messages: ['one', 'two', 'three'],
      });
      const session = await openRabbitSession(config(port));
      const messages = await session.peekMessages({
        vhost: '/',
        queue: 'q',
        count: 2,
        maxBytes: 100,
      });
      expect(messages.map((message) => Buffer.from(message.payload).toString())).toEqual([
        'one',
        'two',
      ]);
      expect(messages.map((message) => message.messagesLeft)).toEqual([2, 1]);
      // The first look finds them fresh; it puts them back marked, and the next look sees it.
      expect(messages.every((message) => !message.redelivered)).toBe(true);
      const again = await session.peekMessages({ vhost: '/', queue: 'q', count: 3, maxBytes: 100 });
      expect(again.map((message) => message.redelivered)).toEqual([true, true, false]);
      expect(messages[0]).toMatchObject({ routingKey: 'q', exchange: '', payloadBytes: 3 });
      // Nothing was taken: three messages are still ready.
      expect(queue.messages).toHaveLength(3);
      const info = await session.getQueue('/', 'q');
      expect(info.ready).toBe(3);
      await session.close();
    });

    it('cuts a long payload and keeps its full length', async () => {
      const { server, port } = await start();
      server.broker.addQueue({ vhost: '/', name: 'q', messages: ['0123456789'] });
      const session = await openRabbitSession(config(port));
      const [message] = await session.peekMessages({
        vhost: '/',
        queue: 'q',
        count: 1,
        maxBytes: 4,
      });
      expect(Buffer.from(message?.payload ?? []).toString()).toBe('0123');
      expect(message?.payloadBytes).toBe(10);
      await session.close();
    });

    it('returns binary payloads byte for byte', async () => {
      const { server, port } = await start();
      const bytes = Buffer.from([0, 255, 128, 10, 13]);
      server.broker.addQueue({ vhost: '/', name: 'q', messages: [{ payload: bytes }] });
      const session = await openRabbitSession(config(port));
      const [message] = await session.peekMessages({
        vhost: '/',
        queue: 'q',
        count: 1,
        maxBytes: 100,
      });
      expect([...(message?.payload ?? [])]).toEqual([...bytes]);
      await session.close();
    });

    it('brings the properties of the publisher', async () => {
      const { server, port } = await start();
      server.broker.addQueue({
        vhost: '/',
        name: 'q',
        messages: [
          {
            payload: Buffer.from('x'),
            properties: { content_type: 'text/plain', headers: { a: 1 } },
          },
        ],
      });
      const session = await openRabbitSession(config(port));
      const [message] = await session.peekMessages({
        vhost: '/',
        queue: 'q',
        count: 1,
        maxBytes: 100,
      });
      expect(message?.properties).toEqual({ content_type: 'text/plain', headers: { a: 1 } });
      await session.close();
    });

    it('asks for JSON when it reads or posts, and for nothing when it only sends a verb', async () => {
      const { server, port } = await start();
      server.broker.addQueue({ vhost: '/', name: 'q', messages: ['x'] });
      const session = await openRabbitSession(config(port));
      await session.getQueue('/', 'q');
      await session.peekMessages({ vhost: '/', queue: 'q', count: 1, maxBytes: 10 });
      await session.purgeQueue('/', 'q');
      await session.deleteQueue('/', 'q');
      const accepted = server.requests.slice(2).map((request) => [request.method, request.accept]);
      // The broker answers a purge that asks for JSON with 406: it has no body to give.
      expect(accepted).toEqual([
        ['GET', 'application/json'],
        ['POST', 'application/json'],
        ['DELETE', undefined],
        ['DELETE', undefined],
      ]);
      await session.close();
    });

    it('brings nothing from an empty queue and fails on one that is not there', async () => {
      const { server, port } = await start();
      server.broker.addQueue({ vhost: '/', name: 'empty' });
      const session = await openRabbitSession(config(port));
      expect(
        await session.peekMessages({ vhost: '/', queue: 'empty', count: 5, maxBytes: 100 }),
      ).toEqual([]);
      const error = await failure(
        session.peekMessages({ vhost: '/', queue: 'gone', count: 1, maxBytes: 1 }),
      );
      expect(error.code).toBe('not-found');
      await session.close();
    });

    it('can be cancelled while the broker thinks', async () => {
      const { server, port } = await start();
      server.broker.addQueue({ vhost: '/', name: 'q', messages: ['x'] });
      server.getDelayMs = 2000;
      const session = await openRabbitSession(config(port));
      const abort = new AbortController();
      const pending = failure(
        session.peekMessages({
          vhost: '/',
          queue: 'q',
          count: 1,
          maxBytes: 10,
          signal: abort.signal,
        }),
      );
      setTimeout(() => {
        abort.abort();
      }, 50);
      expect((await pending).code).toBe('cancelled');
      await session.close();
    });

    it('fails at once when already cancelled', async () => {
      const { server, port } = await start();
      server.broker.addQueue({ vhost: '/', name: 'q', messages: ['x'] });
      const session = await openRabbitSession(config(port));
      const abort = new AbortController();
      abort.abort();
      const error = await failure(
        session.peekMessages({
          vhost: '/',
          queue: 'q',
          count: 1,
          maxBytes: 10,
          signal: abort.signal,
        }),
      );
      expect(error.code).toBe('cancelled');
      await session.close();
    });
  });

  describe('publishing', () => {
    it('sends the payload in base64 with the properties and says whether a queue took it', async () => {
      const { server, port } = await start();
      const queue = server.broker.addQueue({ vhost: '/', name: 'q' });
      const session = await openRabbitSession(config(port));
      const routed = await session.publish({
        vhost: '/',
        exchange: '',
        routingKey: 'q',
        payload: Uint8Array.from([0, 1, 2, 255]),
        properties: { delivery_mode: 2, headers: { trace: '42' } },
      });
      expect(routed).toBe(true);
      const request = server.requests.at(-1);
      expect(request?.path).toBe('/api/exchanges/%2F/amq.default/publish');
      expect(request?.body).toEqual({
        properties: { delivery_mode: 2, headers: { trace: '42' } },
        routing_key: 'q',
        payload: Buffer.from([0, 1, 2, 255]).toString('base64'),
        payload_encoding: 'base64',
      });
      expect([...(queue.messages[0]?.payload ?? [])]).toEqual([0, 1, 2, 255]);
      await session.close();
    });

    it('says no when nothing took the message', async () => {
      const { port } = await start();
      const session = await openRabbitSession(config(port));
      const routed = await session.publish({
        vhost: '/',
        exchange: 'amq.direct',
        routingKey: 'nobody',
        payload: new Uint8Array(),
      });
      expect(routed).toBe(false);
      await session.close();
    });
  });

  describe('declaring and removing', () => {
    it('declares a queue, with a type only when it is not classic', async () => {
      const { server, port } = await start();
      const session = await openRabbitSession(config(port));
      await session.declareQueue({ vhost: '/', name: 'plain', durable: true, autoDelete: false });
      await session.declareQueue({
        vhost: '/',
        name: 'strong',
        type: 'quorum',
        durable: true,
        autoDelete: false,
      });
      const bodies = server.requests
        .filter((request) => request.method === 'PUT')
        .map((request) => request.body);
      expect(bodies).toEqual([
        { durable: true, auto_delete: false, arguments: {} },
        { durable: true, auto_delete: false, arguments: { 'x-queue-type': 'quorum' } },
      ]);
      expect(server.broker.queue('/', 'strong')?.type).toBe('quorum');
      await session.close();
    });

    it('declares an exchange', async () => {
      const { server, port } = await start();
      const session = await openRabbitSession(config(port));
      await session.declareExchange({
        vhost: '/',
        name: 'events',
        type: 'fanout',
        durable: true,
        autoDelete: false,
        internal: false,
      });
      expect(server.broker.exchanges.find((exchange) => exchange.name === 'events')).toMatchObject({
        type: 'fanout',
      });
      await session.close();
    });

    it('purges, deletes a queue and deletes an exchange', async () => {
      const { server, port } = await start();
      const queue = server.broker.addQueue({ vhost: '/', name: 'q', messages: ['a', 'b'] });
      server.broker.exchanges.push({ vhost: '/', name: 'events', type: 'topic' });
      const session = await openRabbitSession(config(port));
      await session.purgeQueue('/', 'q');
      expect(queue.messages).toHaveLength(0);
      expect(server.requests.at(-1)?.path).toBe('/api/queues/%2F/q/contents');
      await session.deleteQueue('/', 'q');
      expect(server.broker.queue('/', 'q')).toBeUndefined();
      await session.deleteExchange('/', 'events');
      expect(server.broker.exchanges.some((exchange) => exchange.name === 'events')).toBe(false);
      await session.close();
    });

    it('reports a refusal with the broker’s reason', async () => {
      const { port } = await start();
      const session = await openRabbitSession(config(port));
      const error = await failure(session.deleteQueue('/', 'gone'));
      expect(error.code).toBe('not-found');
      await session.close();
    });
  });

  it('refuses a call on a closed session', async () => {
    const { port } = await start();
    const session = await openRabbitSession(config(port));
    await session.close();
    expect((await failure(session.listVhosts())).code).toBe('connection-failed');
  });

  it('turns a 5xx page without JSON into an error with the status', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    server.failWith = { status: 502, body: 'Bad gateway' };
    const error = await failure(session.listVhosts());
    expect(error.code).toBe('internal');
    expect(error.message).toBe('HTTP 502: Bad gateway');
    await session.close();
  });

  it('times out a request that takes too long', async () => {
    const { server, port } = await start();
    server.broker.addQueue({ vhost: '/', name: 'q', messages: ['x'] });
    const session = await openRabbitSession(config(port));
    server.getDelayMs = 500;
    const call = (
      session as unknown as {
        call(
          method: string,
          path: string,
          body: unknown,
          options: { timeoutMs: number },
        ): Promise<unknown>;
      }
    ).call.bind(session);
    const error = await failure(
      call(
        'POST',
        'queues/%2F/q/get',
        { count: 1, ackmode: 'ack_requeue_true' },
        { timeoutMs: 50 },
      ),
    );
    expect(error.code).toBe('timeout');
    await session.close();
  });
});

describe('RabbitMQ over TLS', () => {
  it('speaks HTTPS when the connection asks for TLS and checks the certificate', async () => {
    const TLS = join(ROOT, 'docker', 'tls');
    const secure = https.createServer(
      { cert: readFileSync(join(TLS, 'server.crt')), key: readFileSync(join(TLS, 'server.key')) },
      (request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(
          request.url === '/api/whoami'
            ? JSON.stringify({ name: 'guest' })
            : JSON.stringify({ rabbitmq_version: '4.0.0', cluster_name: 'tls' }),
        );
      },
    );
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
    const port = (secure.address() as AddressInfo).port;
    try {
      const session = await openRabbitSession(
        config(port, {
          ssl: { mode: 'require' },
        }),
      );
      expect(session.server.version).toBe('4.0.0');
      await session.close();
      // The certificate is for another name: verifying it fails.
      const strict = await failure(
        openRabbitSession(config(port, { ssl: { mode: 'verify-full' } })),
      );
      expect(strict.code).toBe('connection-failed');
    } finally {
      secure.closeAllConnections();
      await new Promise<void>((resolve) => {
        secure.close(() => {
          resolve();
        });
      });
    }
  });
});

describe('what the session makes of the broker’s JSON', () => {
  it('reads a queue, taking the type from the arguments of an older broker', () => {
    const queue = queueOf(
      {
        name: 'q',
        arguments: { 'x-queue-type': 'quorum' },
        policy: null,
        messages_ready: 3,
        messages_unacknowledged: 1,
        messages: 4,
      },
      'v',
    );
    expect(queue).toMatchObject({
      vhost: 'v',
      type: 'quorum',
      policy: '',
      ready: 3,
      unacked: 1,
      total: 4,
      incomingRate: undefined,
      state: '',
    });
  });

  it('reads the delivery and acknowledgement rates when the broker has them (V13.32)', () => {
    const queue = queueOf({
      name: 'q',
      message_stats: {
        publish_details: { rate: 4.5 },
        deliver_get_details: { rate: 3 },
        ack_details: { rate: 2.5 },
      },
    });
    expect(queue).toMatchObject({ incomingRate: 4.5, deliverRate: 3, ackRate: 2.5 });
    const idle = queueOf({ name: 'q', message_stats: { publish_details: { rate: 'fast' } } });
    expect(idle.incomingRate).toBeUndefined();
    expect('deliverRate' in idle).toBe(false);
    expect('ackRate' in idle).toBe(false);
  });

  it('reads the tags of a user as a list or as the text older brokers send', () => {
    expect(tagsOf(['a', 3, 'b'])).toEqual(['a', 'b']);
    expect(tagsOf('management, policymaker,,')).toEqual(['management', 'policymaker']);
    expect(tagsOf(undefined)).toEqual([]);
    expect(tagsOf(null)).toEqual([]);
  });

  it('reads an exchange and a binding with missing fields as empty ones', () => {
    expect(exchangeOf({ name: 'x', type: 'topic' }, 'v')).toMatchObject({
      vhost: 'v',
      durable: false,
      internal: false,
      arguments: {},
    });
    expect(bindingOf({ source: 'a', destination: 'b', destination_type: 'exchange' })).toEqual({
      source: 'a',
      destination: 'b',
      destinationType: 'exchange',
      routingKey: '',
      arguments: {},
      propertiesKey: '',
    });
    expect(bindingOf(null).destinationType).toBe('queue');
  });

  it('builds the target from the connection: port, user, TLS', () => {
    const plain = rabbitTarget(config(0, { port: undefined, host: ' h ', user: ' ' }), undefined);
    expect(plain).toMatchObject({
      secure: false,
      host: 'h',
      port: 15672,
      user: 'guest',
      vhost: '',
    });
    const withVhost = rabbitTarget(config(5, { database: ' app ' }), undefined);
    expect(withVhost).toMatchObject({ port: 5, vhost: 'app' });
  });
});

describe('RabbitMQ administration over HTTP (V13.28)', () => {
  it('reads the consumers of a queue from its own record', async () => {
    const { server, port } = await start();
    server.broker.addQueue({
      vhost: '/',
      name: 'orders',
      consumers: 2,
      consumerDetails: [
        {
          consumer_tag: 'amq.ctag-1',
          ack_required: true,
          prefetch_count: 20,
          exclusive: false,
          active: true,
          channel_details: {
            connection_name: '127.0.0.1:5000 -> 127.0.0.1:5672',
            name: '127.0.0.1:5000 -> 127.0.0.1:5672 (1)',
            user: 'app',
          },
        },
        { consumer_tag: 'tag-2', active: false },
      ],
    });
    const session = await openRabbitSession(config(port));
    const queue = await session.getQueue('/', 'orders');
    expect(queue.consumerDetails).toEqual([
      {
        tag: 'amq.ctag-1',
        connectionName: '127.0.0.1:5000 -> 127.0.0.1:5672',
        channel: '127.0.0.1:5000 -> 127.0.0.1:5672 (1)',
        user: 'app',
        prefetch: 20,
        ackRequired: true,
        exclusive: false,
        active: true,
      },
      {
        tag: 'tag-2',
        connectionName: '',
        channel: '',
        user: '',
        prefetch: 0,
        ackRequired: false,
        exclusive: false,
        active: false,
      },
    ]);
  });

  it('makes a binding with the routing key and arguments', async () => {
    const { server, port } = await start();
    server.broker.addQueue({ vhost: '/', name: 'orders' });
    const session = await openRabbitSession(config(port));
    await session.bind('/', {
      source: 'amq.topic',
      destination: 'orders',
      destinationType: 'queue',
      routingKey: 'order.#',
    });
    const sent = server.requests.at(-1);
    expect(sent?.method).toBe('POST');
    expect(sent?.path).toBe('/api/bindings/%2F/e/amq.topic/q/orders');
    expect(sent?.body).toEqual({ routing_key: 'order.#', arguments: {} });
    expect(await session.listBindings('/', { queue: 'orders' })).toMatchObject([
      { source: 'amq.topic', routingKey: 'order.#', propertiesKey: 'order.%23' },
    ]);
    // The same binding again changes nothing.
    await session.bind('/', {
      source: 'amq.topic',
      destination: 'orders',
      destinationType: 'queue',
      routingKey: 'order.#',
      arguments: {},
    });
    expect(server.broker.bindings).toHaveLength(1);
  });

  it('binds an exchange to an exchange, and quotes names in the path', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    await session.bind('/', {
      source: 'amq.direct',
      destination: 'amq.topic',
      destinationType: 'exchange',
      routingKey: '',
    });
    expect(server.requests.at(-1)?.path).toBe('/api/bindings/%2F/e/amq.direct/e/amq.topic');
    await session.bind('my vhost', {
      source: 'a/b',
      destination: 'c d',
      destinationType: 'queue',
      routingKey: 'k',
    });
    expect(server.requests.at(-1)?.path).toBe('/api/bindings/my%20vhost/e/a%2Fb/q/c%20d');
  });

  it('passes on the broker’s refusal of a binding from the default exchange', async () => {
    const { port } = await start();
    const session = await openRabbitSession(config(port));
    const error = await failure(
      session.bind('/', {
        source: 'amq.default',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'orders',
      }),
    );
    expect(error.code).toBe('auth-failed');
    expect(error.driverCode).toBe(401);
  });

  it('removes a binding by the name the broker gave it, quoted twice in the path', async () => {
    const { server, port } = await start();
    server.broker.addQueue({ vhost: '/', name: 'orders' });
    const session = await openRabbitSession(config(port));
    for (const routingKey of ['a#b/c d', '100%', '', 'plain']) {
      await session.bind('/', {
        source: 'amq.topic',
        destination: 'orders',
        destinationType: 'queue',
        routingKey,
      });
    }
    const bindings = await session.listBindings('/', { queue: 'orders' });
    expect(bindings.map((binding) => binding.propertiesKey).sort()).toEqual(
      ['100%25', 'a%23b%2Fc+d', 'plain', '~'].sort(),
    );
    for (const binding of bindings) {
      await session.unbind('/', binding);
    }
    expect(server.broker.bindings).toEqual([]);
    const paths = server.requests.filter((r) => r.method === 'DELETE').map((r) => r.path);
    expect(paths).toContain('/api/bindings/%2F/e/amq.topic/q/orders/a%2523b%252Fc%2Bd');
    expect(paths).toContain('/api/bindings/%2F/e/amq.topic/q/orders/100%2525');
    expect(paths).toContain('/api/bindings/%2F/e/amq.topic/q/orders/~');
  });

  it('says not-found when the binding is gone already', async () => {
    const { port } = await start();
    const session = await openRabbitSession(config(port));
    const error = await failure(
      session.unbind('/', {
        source: 'amq.topic',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'k',
        arguments: {},
        propertiesKey: 'k',
      }),
    );
    expect(error.code).toBe('not-found');
  });

  it('lists the connections of a virtual host and closes one by name', async () => {
    const { server, port } = await start();
    server.broker.connections.push(
      {
        name: '127.0.0.1:5000 -> 127.0.0.1:5672',
        vhost: '/',
        user: 'app',
        peerPort: 5000,
        channels: 3,
        connectedAt: 1_700_000_000_000,
        clientName: 'billing',
        product: 'pika',
      },
      { name: 'other', vhost: 'v2' },
    );
    const session = await openRabbitSession(config(port));
    const page = await session.listConnections('/');
    expect(page.total).toBe(1);
    expect(page.items[0]).toEqual({
      name: '127.0.0.1:5000 -> 127.0.0.1:5672',
      user: 'app',
      vhost: '/',
      state: 'running',
      protocol: 'AMQP 0-9-1',
      peer: '127.0.0.1:5000',
      channels: 3,
      connectedAt: 1_700_000_000_000,
      receivedBytes: 1024,
      sentBytes: 2048,
      clientName: 'billing',
      product: 'pika',
    });
    expect(server.requests.at(-1)?.path).toBe('/api/vhosts/%2F/connections');
    await session.closeConnection('127.0.0.1:5000 -> 127.0.0.1:5672');
    expect(server.requests.at(-1)?.path).toBe(
      '/api/connections/127.0.0.1%3A5000%20-%3E%20127.0.0.1%3A5672',
    );
    expect(server.broker.connections.map((c) => c.name)).toEqual(['other']);
  });

  it('reads a connection with missing fields as an empty one', () => {
    expect(connectionOf({})).toEqual({
      name: '',
      user: '',
      vhost: '',
      state: '',
      protocol: '',
      peer: '',
      channels: 0,
      connectedAt: undefined,
      receivedBytes: 0,
      sentBytes: 0,
      clientName: '',
      product: '',
    });
    expect(connectionOf({ peer_host: 'h' }).peer).toBe('h');
    expect(connectionOf(null).name).toBe('');
  });

  it('lists the users, sorted', async () => {
    const { server, port } = await start();
    server.broker.users.push({ name: 'ann', tags: ['monitoring', 'management'] });
    server.broker.users.push({ name: 'bob', tags: [] });
    const session = await openRabbitSession(config(port));
    expect(await session.listUsers()).toEqual([
      { name: 'ann', tags: ['monitoring', 'management'] },
      { name: 'bob', tags: [] },
      { name: 'guest', tags: ['administrator'] },
    ]);
  });

  it('creates a user with the tags joined, and deletes it', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    await session.createUser({
      name: 'new user',
      password: 'pw',
      tags: ['management', 'policymaker'],
    });
    expect(server.requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/users/new%20user',
      body: { password: 'pw', tags: 'management,policymaker' },
    });
    expect(server.broker.users.map((u) => u.name)).toContain('new user');
    await session.deleteUser('new user');
    expect(server.broker.users.map((u) => u.name)).toEqual(['guest']);
  });

  it('changes the tags of a user and keeps the password (V13.32)', async () => {
    const { server, port } = await start();
    server.broker.users.push({ name: 'ann', tags: ['monitoring'], password: 'secret' });
    const session = await openRabbitSession(config(port));
    await session.updateUser('ann', { tags: ['management', 'policymaker'] });
    // The broker forgets the password of a PUT without one, so the stored hash goes back.
    expect(server.requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/users/ann',
      body: {
        password_hash: 'h:secret',
        hashing_algorithm: 'fake_hash',
        tags: 'management,policymaker',
      },
    });
    const ann = server.broker.users.find((u) => u.name === 'ann');
    expect(ann).toMatchObject({ tags: ['management', 'policymaker'], password: 'secret' });
  });

  it('changes the password of a user and keeps the tags', async () => {
    const { server, port } = await start();
    server.broker.users.push({ name: 'ann', tags: ['monitoring', 'management'], password: 'old' });
    const session = await openRabbitSession(config(port));
    await session.updateUser('ann', { password: 'new' });
    expect(server.requests.at(-1)).toMatchObject({
      body: { password: 'new', tags: 'monitoring,management' },
    });
    expect(server.broker.users.find((u) => u.name === 'ann')).toMatchObject({
      password: 'new',
      tags: ['monitoring', 'management'],
    });
  });

  it('changes the password and the tags together, and clears the tags with an empty list', async () => {
    const { server, port } = await start();
    server.broker.users.push({ name: 'ann', tags: ['monitoring'], password: 'old' });
    const session = await openRabbitSession(config(port));
    await session.updateUser('ann', { password: 'new', tags: ['administrator'] });
    expect(server.broker.users.find((u) => u.name === 'ann')).toMatchObject({
      password: 'new',
      tags: ['administrator'],
    });
    await session.updateUser('ann', { tags: [] });
    expect(server.broker.users.find((u) => u.name === 'ann')).toMatchObject({
      password: 'new',
      tags: [],
    });
  });

  it('refuses to change a user the broker does not know', async () => {
    const { port } = await start();
    const session = await openRabbitSession(config(port));
    expect((await failure(session.updateUser('ghost', { tags: [] }))).code).toBe('not-found');
  });

  it('makes and deletes a virtual host, quoting its name in the path (V13.32)', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    await session.createVhost('app/one');
    expect(server.requests.at(-1)).toMatchObject({ method: 'PUT', path: '/api/vhosts/app%2Fone' });
    expect(server.broker.vhosts.has('app/one')).toBe(true);
    // Making one that exists is not an error: the broker answers 204.
    await session.createVhost('app/one');
    expect((await session.listVhosts()).map((vhost) => vhost.name)).toContain('app/one');
    server.broker.addQueue({ vhost: 'app/one', name: 'inside' });
    await session.deleteVhost('app/one');
    expect(server.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/vhosts/app%2Fone',
    });
    expect(server.broker.vhosts.has('app/one')).toBe(false);
    expect(server.broker.queues.some((queue) => queue.vhost === 'app/one')).toBe(false);
    expect((await failure(session.deleteVhost('app/one'))).code).toBe('not-found');
  });

  it('reports a user without the administrator tag as refused', async () => {
    const { server, port } = await start();
    server.administrator = false;
    const session = await openRabbitSession(config(port));
    const error = await failure(session.listUsers());
    expect(error.driverCode).toBe(401);
    expect(error.message).toContain('administrator');
    expect((await failure(session.listPermissions('/'))).driverCode).toBe(401);
  });

  it('sets, lists and clears permissions', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    await session.setPermission('/', {
      user: 'guest',
      configure: '^q\\..*',
      write: '.*',
      read: '',
    });
    expect(server.requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/permissions/%2F/guest',
      body: { configure: '^q\\..*', write: '.*', read: '' },
    });
    await session.setPermission('/', { user: 'ann', configure: '', write: '', read: '.*' });
    expect(await session.listPermissions('/')).toEqual([
      { user: 'ann', configure: '', write: '', read: '.*' },
      { user: 'guest', configure: '^q\\..*', write: '.*', read: '' },
    ]);
    await session.clearPermission('/', 'ann');
    expect((await session.listPermissions('/')).map((p) => p.user)).toEqual(['guest']);
  });

  it('sets, lists and deletes policies', async () => {
    const { server, port } = await start();
    const session = await openRabbitSession(config(port));
    await session.setPolicy({
      vhost: '/',
      name: 'ttl',
      pattern: '^tmp\\.',
      applyTo: 'queues',
      priority: 5,
      definition: { 'message-ttl': 60_000 },
    });
    expect(server.requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/policies/%2F/ttl',
      body: {
        pattern: '^tmp\\.',
        'apply-to': 'queues',
        priority: 5,
        definition: { 'message-ttl': 60_000 },
      },
    });
    expect(await session.listPolicies('/')).toEqual([
      {
        name: 'ttl',
        pattern: '^tmp\\.',
        applyTo: 'queues',
        priority: 5,
        definition: { 'message-ttl': 60_000 },
      },
    ]);
    await session.deletePolicy('/', 'ttl');
    expect(await session.listPolicies('/')).toEqual([]);
    expect((await failure(session.deletePolicy('/', 'ttl'))).code).toBe('not-found');
  });

  it('reads a policy without an apply-to as one for everything', () => {
    expect(policyOf({ name: 'p', pattern: '.*', definition: { x: 1 } })).toEqual({
      name: 'p',
      pattern: '.*',
      applyTo: 'all',
      priority: 0,
      definition: { x: 1 },
    });
    expect(policyOf(undefined).name).toBe('');
  });
});

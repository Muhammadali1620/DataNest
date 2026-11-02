// A RabbitMQ in memory (V13.26), in two shapes: `FakeRabbitServer` answers the management
// API over real HTTP on a local port, so the driver's session is tested end to end, and
// `FakeRabbitSession` is the session itself, for the layers above the driver. Both keep
// what was asked, so the tests can show that a peek puts every message back.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  RabbitBinding,
  RabbitDriver,
  RabbitExchangeDeclaration,
  RabbitExchangeInfo,
  RabbitMessage,
  RabbitPage,
  RabbitPeekRequest,
  RabbitPublishRequest,
  RabbitQueueDeclaration,
  RabbitQueueInfo,
  RabbitServerInfo,
  RabbitSession,
  RabbitVhostInfo,
} from '../../src/drivers/rabbitmq-driver';
import { DbError } from '../../src/core/errors';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';

export interface FakeMessage {
  readonly payload: Buffer;
  readonly properties?: Record<string, unknown>;
  redelivered?: boolean;
}

export interface FakeQueue {
  readonly vhost: string;
  readonly name: string;
  readonly type?: string;
  readonly durable?: boolean;
  readonly autoDelete?: boolean;
  readonly exclusive?: boolean;
  state?: string;
  consumers?: number;
  policy?: string | null;
  arguments?: Record<string, unknown>;
  unacked?: number;
  messages: FakeMessage[];
}

export interface FakeExchange {
  readonly vhost: string;
  readonly name: string;
  readonly type: string;
  readonly durable?: boolean;
  readonly autoDelete?: boolean;
  readonly internal?: boolean;
}

export interface FakeBinding {
  readonly vhost: string;
  readonly source: string;
  readonly destination: string;
  readonly destinationType: 'queue' | 'exchange';
  readonly routingKey: string;
  readonly arguments?: Record<string, unknown>;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
  readonly body: unknown;
}

/** The state both fakes share. */
export class FakeBroker {
  version = '3.13.7';
  clusterName = 'rabbit@fake';
  readonly vhosts = new Set<string>(['/']);
  readonly queues: FakeQueue[] = [];
  readonly exchanges: FakeExchange[] = [
    { vhost: '/', name: '', type: 'direct', durable: true },
    { vhost: '/', name: 'amq.direct', type: 'direct', durable: true },
    { vhost: '/', name: 'amq.topic', type: 'topic', durable: true },
  ];
  readonly bindings: FakeBinding[] = [];
  /** Pretends a queue holds more than it lists in a page. */
  extraTotal = 0;

  addQueue(
    queue: Omit<FakeQueue, 'messages'> & { messages?: (string | FakeMessage)[] },
  ): FakeQueue {
    this.vhosts.add(queue.vhost);
    const made: FakeQueue = {
      ...queue,
      messages: (queue.messages ?? []).map((one) =>
        typeof one === 'string' ? { payload: Buffer.from(one, 'utf8') } : one,
      ),
    };
    this.queues.push(made);
    return made;
  }

  queue(vhost: string, name: string): FakeQueue | undefined {
    return this.queues.find((one) => one.vhost === vhost && one.name === name);
  }
}

function queueJson(queue: FakeQueue): Record<string, unknown> {
  return {
    name: queue.name,
    vhost: queue.vhost,
    durable: queue.durable ?? true,
    auto_delete: queue.autoDelete ?? false,
    exclusive: queue.exclusive ?? false,
    state: queue.state ?? 'running',
    messages_ready: queue.messages.length,
    messages_unacknowledged: queue.unacked ?? 0,
    messages: queue.messages.length + (queue.unacked ?? 0),
    consumers: queue.consumers ?? 0,
    memory: 12_345,
    policy: queue.policy ?? null,
    arguments: queue.arguments ?? {},
    ...(queue.type === undefined ? {} : { type: queue.type }),
    node: 'rabbit@fake',
    message_stats: { publish_details: { rate: 1.5 } },
  };
}

function exchangeJson(exchange: FakeExchange): Record<string, unknown> {
  return {
    name: exchange.name,
    vhost: exchange.vhost,
    type: exchange.type,
    durable: exchange.durable ?? true,
    auto_delete: exchange.autoDelete ?? false,
    internal: exchange.internal ?? false,
    arguments: {},
  };
}

function bindingJson(binding: FakeBinding): Record<string, unknown> {
  return {
    source: binding.source,
    vhost: binding.vhost,
    destination: binding.destination,
    destination_type: binding.destinationType,
    routing_key: binding.routingKey,
    arguments: binding.arguments ?? {},
  };
}

/** The management API over HTTP, on 127.0.0.1. */
export class FakeRabbitServer {
  readonly broker = new FakeBroker();
  readonly requests: RecordedRequest[] = [];
  user = 'guest';
  password = 'guest';
  /** A status to answer every request with (to test failures). */
  failWith: { status: number; body: string } | undefined;
  /** Milliseconds to wait before answering `get`. */
  getDelayMs = 0;
  private readonly server: http.Server;

  constructor() {
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body: unknown = text === '' ? undefined : JSON.parse(text);
        const url = new URL(request.url ?? '/', 'http://localhost');
        this.requests.push({
          method: request.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.authorization,
          accept: request.headers.accept,
          body,
        });
        const answer = (status: number, json?: unknown): void => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          response.end(json === undefined ? '' : JSON.stringify(json));
        };
        if (this.failWith !== undefined) {
          response.statusCode = this.failWith.status;
          response.end(this.failWith.body);
          return;
        }
        const send = (): void => {
          this.route(request.method ?? 'GET', url, body, request.headers.authorization, answer);
        };
        if (this.getDelayMs > 0 && url.pathname.endsWith('/get')) {
          setTimeout(send, this.getDelayMs);
        } else {
          send();
        }
      });
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private route(
    method: string,
    url: URL,
    body: unknown,
    authorization: string | undefined,
    answer: (status: number, json?: unknown) => void,
  ): void {
    const expected = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
    if (authorization !== expected) {
      answer(401, { error: 'not_authorised', reason: 'Login failed' });
      return;
    }
    const parts = url.pathname
      .replace(/^\/api\//u, '')
      .split('/')
      .map((part) => decodeURIComponent(part));
    const [kind, vhost, name, ...rest] = parts;
    const broker = this.broker;
    if (kind === 'overview') {
      answer(200, { rabbitmq_version: broker.version, cluster_name: broker.clusterName });
      return;
    }
    if (kind === 'whoami') {
      answer(200, { name: this.user, tags: ['administrator'] });
      return;
    }
    if (kind === 'vhosts') {
      if (vhost === undefined) {
        answer(
          200,
          [...broker.vhosts].map((one) => ({
            name: one,
            messages: broker.queues
              .filter((q) => q.vhost === one)
              .reduce((sum, q) => sum + q.messages.length, 0),
          })),
        );
      } else if (broker.vhosts.has(vhost)) {
        answer(200, { name: vhost, messages: 0 });
      } else {
        answer(404, { error: 'Object Not Found', reason: 'Not Found' });
      }
      return;
    }
    if (kind === 'queues' && vhost !== undefined) {
      this.queueRoute(method, vhost, name, rest, url, body, answer);
      return;
    }
    if (kind === 'exchanges' && vhost !== undefined) {
      this.exchangeRoute(method, vhost, name, rest, url, body, answer);
      return;
    }
    answer(404, { error: 'Object Not Found', reason: 'Not Found' });
  }

  private page(items: unknown[], url: URL, answer: (s: number, j?: unknown) => void): void {
    if (url.searchParams.get('page') === null) {
      answer(200, items);
      return;
    }
    const size = Number(url.searchParams.get('page_size') ?? '100');
    answer(200, {
      items: items.slice(0, size),
      total_count: items.length + this.broker.extraTotal,
      filtered_count: items.length + this.broker.extraTotal,
      page: 1,
      page_size: size,
    });
  }

  private queueRoute(
    method: string,
    vhost: string,
    name: string | undefined,
    rest: string[],
    url: URL,
    body: unknown,
    answer: (status: number, json?: unknown) => void,
  ): void {
    const broker = this.broker;
    if (name === undefined) {
      this.page(broker.queues.filter((q) => q.vhost === vhost).map(queueJson), url, answer);
      return;
    }
    const queue = broker.queue(vhost, name);
    const missing = (): void => {
      answer(404, { error: 'Object Not Found', reason: 'Not Found' });
    };
    const action = rest[0];
    if (action === 'get' && method === 'POST') {
      if (queue === undefined) {
        missing();
        return;
      }
      const request = body as {
        count: number;
        ackmode: string;
        encoding: string;
        truncate?: number;
      };
      // Only the requeueing mode is honoured: the others would take the messages.
      const taken =
        request.ackmode === 'ack_requeue_true' ? queue.messages.slice(0, request.count) : [];
      // As the broker does: the flag tells what it knew when it handed the message out, and
      // the message goes back marked for the next look.
      const flags = taken.map((message) => message.redelivered === true);
      for (const message of taken) {
        message.redelivered = true;
      }
      answer(
        200,
        taken.map((message, index) => ({
          payload_bytes: message.payload.length,
          redelivered: flags[index] === true,
          exchange: '',
          routing_key: queue.name,
          message_count: queue.messages.length - index - 1,
          properties: message.properties ?? {},
          payload: message.payload
            .subarray(0, request.truncate ?? message.payload.length)
            .toString('base64'),
          payload_encoding: 'base64',
        })),
      );
      return;
    }
    if (action === 'bindings' && method === 'GET') {
      answer(
        200,
        broker.bindings
          .filter(
            (b) => b.vhost === vhost && b.destination === name && b.destinationType === 'queue',
          )
          .map(bindingJson),
      );
      return;
    }
    if (action === 'contents' && method === 'DELETE') {
      if (queue === undefined) {
        missing();
        return;
      }
      queue.messages.length = 0;
      answer(204);
      return;
    }
    if (rest.length > 0) {
      missing();
      return;
    }
    if (method === 'GET') {
      if (queue === undefined) {
        missing();
      } else {
        answer(200, queueJson(queue));
      }
    } else if (method === 'PUT') {
      const declared = body as {
        durable: boolean;
        auto_delete: boolean;
        arguments: Record<string, unknown>;
      };
      if (queue === undefined) {
        broker.addQueue({
          vhost,
          name,
          durable: declared.durable,
          autoDelete: declared.auto_delete,
          arguments: declared.arguments,
          type:
            typeof declared.arguments['x-queue-type'] === 'string'
              ? declared.arguments['x-queue-type']
              : 'classic',
        });
        answer(201);
      } else {
        answer(204);
      }
    } else if (method === 'DELETE') {
      if (queue === undefined) {
        missing();
      } else {
        broker.queues.splice(broker.queues.indexOf(queue), 1);
        answer(204);
      }
    } else {
      answer(405, { error: 'method_not_allowed', reason: method });
    }
  }

  private exchangeRoute(
    method: string,
    vhost: string,
    name: string | undefined,
    rest: string[],
    url: URL,
    body: unknown,
    answer: (status: number, json?: unknown) => void,
  ): void {
    const broker = this.broker;
    if (name === undefined) {
      this.page(broker.exchanges.filter((e) => e.vhost === vhost).map(exchangeJson), url, answer);
      return;
    }
    const key = name === 'amq.default' ? '' : name;
    const exchange = broker.exchanges.find((e) => e.vhost === vhost && e.name === key);
    const missing = (): void => {
      answer(404, { error: 'Object Not Found', reason: 'Not Found' });
    };
    if (rest[0] === 'publish' && method === 'POST') {
      const request = body as {
        routing_key: string;
        payload: string;
        payload_encoding: string;
        properties: Record<string, unknown>;
      };
      // The default exchange routes by queue name; others by the bindings.
      const targets =
        key === ''
          ? broker.queues.filter((q) => q.vhost === vhost && q.name === request.routing_key)
          : broker.bindings
              .filter(
                (b) =>
                  b.vhost === vhost &&
                  b.source === key &&
                  b.routingKey === request.routing_key &&
                  b.destinationType === 'queue',
              )
              .flatMap((b) =>
                broker.queues.filter((q) => q.vhost === vhost && q.name === b.destination),
              );
      for (const target of targets) {
        target.messages.push({
          payload: Buffer.from(
            request.payload,
            request.payload_encoding === 'base64' ? 'base64' : 'utf8',
          ),
          properties: request.properties,
        });
      }
      answer(200, { routed: targets.length > 0 });
      return;
    }
    if (rest[0] === 'bindings' && method === 'GET') {
      const side = rest[1];
      answer(
        200,
        broker.bindings
          .filter(
            (b) =>
              b.vhost === vhost &&
              (side === 'source'
                ? b.source === key
                : b.destination === key && b.destinationType === 'exchange'),
          )
          .map(bindingJson),
      );
      return;
    }
    if (rest.length > 0) {
      missing();
      return;
    }
    if (method === 'GET') {
      if (exchange === undefined) {
        missing();
      } else {
        answer(200, exchangeJson(exchange));
      }
    } else if (method === 'PUT') {
      const declared = body as {
        type: string;
        durable: boolean;
        auto_delete: boolean;
        internal: boolean;
      };
      if (exchange === undefined) {
        broker.exchanges.push({
          vhost,
          name: key,
          type: declared.type,
          durable: declared.durable,
          autoDelete: declared.auto_delete,
          internal: declared.internal,
        });
        answer(201);
      } else {
        answer(204);
      }
    } else if (method === 'DELETE') {
      if (exchange === undefined) {
        missing();
      } else {
        broker.exchanges.splice(broker.exchanges.indexOf(exchange), 1);
        answer(204);
      }
    } else {
      answer(405, { error: 'method_not_allowed', reason: method });
    }
  }
}

/** The session in memory, for the layers above the driver. */
export class FakeRabbitSession implements RabbitSession {
  readonly broker: FakeBroker;
  server: RabbitServerInfo = { version: '3.13.7', clusterName: 'rabbit@fake', user: 'guest' };
  readonly calls: string[] = [];
  closed = false;
  /** Makes the next call of this name throw. */
  readonly failures = new Map<string, Error>();

  constructor(broker = new FakeBroker()) {
    this.broker = broker;
  }

  private note(name: string): void {
    this.calls.push(name);
    const failure = this.failures.get(name);
    if (failure !== undefined) {
      this.failures.delete(name);
      throw failure;
    }
  }

  listVhosts(): Promise<readonly RabbitVhostInfo[]> {
    this.note('listVhosts');
    return Promise.resolve([...this.broker.vhosts].map((name) => ({ name, messages: 0 })));
  }

  listQueues(vhost: string): Promise<RabbitPage<RabbitQueueInfo>> {
    this.note('listQueues');
    const items = this.broker.queues.filter((q) => q.vhost === vhost).map(queueInfo);
    return Promise.resolve({ items, total: items.length + this.broker.extraTotal });
  }

  listExchanges(vhost: string): Promise<RabbitPage<RabbitExchangeInfo>> {
    this.note('listExchanges');
    const items = this.broker.exchanges.filter((e) => e.vhost === vhost).map(exchangeInfo);
    return Promise.resolve({ items, total: items.length + this.broker.extraTotal });
  }

  getQueue(vhost: string, name: string): Promise<RabbitQueueInfo> {
    this.note('getQueue');
    const queue = this.broker.queue(vhost, name);
    if (queue === undefined) {
      return Promise.reject(new DbError('not-found', 'Not Found'));
    }
    return Promise.resolve(queueInfo(queue));
  }

  getExchange(vhost: string, name: string): Promise<RabbitExchangeInfo> {
    this.note('getExchange');
    const exchange = this.broker.exchanges.find((e) => e.vhost === vhost && e.name === name);
    if (exchange === undefined) {
      return Promise.reject(new DbError('not-found', 'Not Found'));
    }
    return Promise.resolve(exchangeInfo(exchange));
  }

  listBindings(
    vhost: string,
    target: { readonly queue: string } | { readonly exchange: string },
  ): Promise<readonly RabbitBinding[]> {
    this.note('listBindings');
    const found = this.broker.bindings.filter((b) =>
      b.vhost !== vhost
        ? false
        : 'queue' in target
          ? b.destination === target.queue && b.destinationType === 'queue'
          : b.source === target.exchange ||
            (b.destination === target.exchange && b.destinationType === 'exchange'),
    );
    return Promise.resolve(
      found.map((b) => ({
        source: b.source,
        destination: b.destination,
        destinationType: b.destinationType,
        routingKey: b.routingKey,
        arguments: b.arguments ?? {},
      })),
    );
  }

  peekMessages(request: RabbitPeekRequest): Promise<readonly RabbitMessage[]> {
    this.note('peekMessages');
    const queue = this.broker.queue(request.vhost, request.queue);
    if (queue === undefined) {
      return Promise.reject(new DbError('not-found', 'Not Found'));
    }
    const taken = queue.messages.slice(0, request.count);
    const flags = taken.map((message) => message.redelivered === true);
    for (const message of taken) {
      message.redelivered = true;
    }
    return Promise.resolve(
      taken.map((message, index) => ({
        payload: Uint8Array.from(message.payload.subarray(0, request.maxBytes)),
        payloadBytes: message.payload.length,
        redelivered: flags[index] === true,
        exchange: '',
        routingKey: queue.name,
        messagesLeft: queue.messages.length - index - 1,
        properties: message.properties ?? {},
      })),
    );
  }

  readonly published: RabbitPublishRequest[] = [];

  publish(request: RabbitPublishRequest): Promise<boolean> {
    this.note('publish');
    this.published.push(request);
    const targets =
      request.exchange === ''
        ? this.broker.queues.filter(
            (q) => q.vhost === request.vhost && q.name === request.routingKey,
          )
        : [];
    for (const target of targets) {
      target.messages.push({
        payload: Buffer.from(request.payload),
        ...(request.properties === undefined ? {} : { properties: { ...request.properties } }),
      });
    }
    return Promise.resolve(targets.length > 0);
  }

  declareQueue(declaration: RabbitQueueDeclaration): Promise<void> {
    this.note('declareQueue');
    this.broker.addQueue({
      vhost: declaration.vhost,
      name: declaration.name,
      durable: declaration.durable,
      autoDelete: declaration.autoDelete,
      ...(declaration.type === undefined ? {} : { type: declaration.type }),
    });
    return Promise.resolve();
  }

  deleteQueue(vhost: string, name: string): Promise<void> {
    this.note('deleteQueue');
    const queue = this.broker.queue(vhost, name);
    if (queue !== undefined) {
      this.broker.queues.splice(this.broker.queues.indexOf(queue), 1);
    }
    return Promise.resolve();
  }

  purgeQueue(vhost: string, name: string): Promise<void> {
    this.note('purgeQueue');
    const queue = this.broker.queue(vhost, name);
    if (queue !== undefined) {
      queue.messages.length = 0;
    }
    return Promise.resolve();
  }

  declareExchange(declaration: RabbitExchangeDeclaration): Promise<void> {
    this.note('declareExchange');
    this.broker.exchanges.push({
      vhost: declaration.vhost,
      name: declaration.name,
      type: declaration.type,
      durable: declaration.durable,
      autoDelete: declaration.autoDelete,
      internal: declaration.internal,
    });
    return Promise.resolve();
  }

  deleteExchange(vhost: string, name: string): Promise<void> {
    this.note('deleteExchange');
    const index = this.broker.exchanges.findIndex((e) => e.vhost === vhost && e.name === name);
    if (index >= 0) {
      this.broker.exchanges.splice(index, 1);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function queueInfo(queue: FakeQueue): RabbitQueueInfo {
  return {
    vhost: queue.vhost,
    name: queue.name,
    type: queue.type ?? '',
    durable: queue.durable ?? true,
    autoDelete: queue.autoDelete ?? false,
    exclusive: queue.exclusive ?? false,
    state: queue.state ?? 'running',
    ready: queue.messages.length,
    unacked: queue.unacked ?? 0,
    total: queue.messages.length + (queue.unacked ?? 0),
    consumers: queue.consumers ?? 0,
    memory: 12_345,
    policy: queue.policy ?? '',
    arguments: queue.arguments ?? {},
    incomingRate: 1.5,
    node: 'rabbit@fake',
  };
}

function exchangeInfo(exchange: FakeExchange): RabbitExchangeInfo {
  return {
    vhost: exchange.vhost,
    name: exchange.name,
    type: exchange.type,
    durable: exchange.durable ?? true,
    autoDelete: exchange.autoDelete ?? false,
    internal: exchange.internal ?? false,
    policy: '',
    arguments: {},
  };
}

/** A driver that hands out one fake session and remembers how it was opened. */
export class FakeRabbitDriver implements RabbitDriver {
  readonly id = 'rabbitmq';
  readonly session = new FakeRabbitSession();
  readonly configs: ResolvedConnectionConfig[] = [];
  /** An error to throw when opening. */
  openError: Error | undefined;

  openSession(config: ResolvedConnectionConfig): Promise<RabbitSession> {
    this.configs.push(config);
    if (this.openError !== undefined) {
      return Promise.reject(this.openError);
    }
    return Promise.resolve(this.session);
  }
}

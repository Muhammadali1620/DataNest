// A RabbitMQ in memory (V13.26), in two shapes: `FakeRabbitServer` answers the management
// API over real HTTP on a local port, so the driver's session is tested end to end, and
// `FakeRabbitSession` is the session itself, for the layers above the driver. Both keep
// what was asked, so the tests can show that a peek puts every message back.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  RabbitBinding,
  RabbitBindingRequest,
  RabbitClusterInfo,
  RabbitConnectionInfo,
  RabbitDriver,
  RabbitExchangeDeclaration,
  RabbitExchangeInfo,
  RabbitGlobalParameter,
  RabbitMessage,
  RabbitPage,
  RabbitPeekRequest,
  RabbitPermissionInfo,
  RabbitPolicyDeclaration,
  RabbitPolicyInfo,
  RabbitPublishRequest,
  RabbitQueueDeclaration,
  RabbitQueueInfo,
  RabbitServerInfo,
  RabbitSession,
  RabbitUserInfo,
  RabbitVhostInfo,
  RabbitVhostLimits,
  VhostLimitName,
} from '../../src/drivers/rabbitmq-driver';
import { DbError } from '../../src/core/errors';
import { consumerOf, nodeOf } from '../../src/drivers/rabbitmq/session';
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
  /** Rates per second the queue's `message_stats` carries (V13.32); publish defaults to 1.5. */
  rates?: { publish?: number; deliver?: number; ack?: number };
  /** The `consumer_details` the queue's own record carries, as the API words them. */
  consumerDetails?: Record<string, unknown>[];
  messages: FakeMessage[];
}

export interface FakeConnection {
  readonly name: string;
  readonly user?: string;
  readonly vhost: string;
  readonly state?: string;
  readonly peerHost?: string;
  readonly peerPort?: number;
  readonly channels?: number;
  readonly connectedAt?: number;
  readonly clientName?: string;
  readonly product?: string;
}

/** What the broker calls a binding: the routing key quoted as in a URL, `~` when it is empty. */
export function propertiesKeyOf(routingKey: string, args: Record<string, unknown> = {}): string {
  const quoted = encodeURIComponent(routingKey).replaceAll('%20', '+');
  const base = routingKey === '' ? '~' : quoted;
  return Object.keys(args).length === 0 ? base : `${base}_${JSON.stringify(args).length}`;
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
  /** Removes a virtual host with what is in it; false when there was none. */
  deleteVhost(name: string): boolean {
    if (!this.vhosts.delete(name)) {
      return false;
    }
    for (const list of [this.queues, this.exchanges, this.bindings, this.permissions]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if ((list[index] as { vhost: string }).vhost === name) {
          list.splice(index, 1);
        }
      }
    }
    return true;
  }

  /** Pretends a queue holds more than it lists in a page. */
  extraTotal = 0;
  readonly connections: FakeConnection[] = [];
  readonly users: { name: string; tags: string[]; password?: string }[] = [
    { name: 'guest', tags: ['administrator'] },
  ];
  readonly permissions: {
    vhost: string;
    user: string;
    configure: string;
    write: string;
    read: string;
  }[] = [];
  readonly policies: {
    vhost: string;
    name: string;
    pattern: string;
    applyTo: string;
    priority: number;
    definition: Record<string, unknown>;
  }[] = [];

  /** The nodes as the API words them; one by default. */
  nodes: Record<string, unknown>[] = [
    {
      name: 'rabbit@fake',
      type: 'disc',
      running: true,
      uptime: 90_000,
      mem_used: 170_000_000,
      mem_limit: 400_000_000,
      mem_alarm: false,
      disk_free: 100_000_000_000,
      disk_free_limit: 50_000_000,
      disk_free_alarm: false,
      fd_used: 43,
      fd_total: 1024,
      sockets_used: 2,
      sockets_total: 800,
      proc_used: 400,
      proc_total: 1_000_000,
      processors: 4,
      partitions: [],
      being_drained: false,
    },
  ];
  /** The rest of the overview: totals, listeners and the Erlang version. */
  overview: Record<string, unknown> = {
    erlang_version: '26.2',
    node: 'rabbit@fake',
    object_totals: { queues: 2, exchanges: 3, connections: 1, channels: 1, consumers: 1 },
    queue_totals: { messages_ready: 5, messages_unacknowledged: 2 },
    listeners: [{ node: 'rabbit@fake', protocol: 'amqp', ip_address: '::', port: 5672 }],
  };
  readonly globalParameters: { name: string; value: unknown }[] = [
    { name: 'cluster_name', value: 'rabbit@fake' },
  ];
  readonly vhostLimits = new Map<string, Record<string, number>>();

  /** Makes a binding unless an equal one is there. */
  bind(vhost: string, request: RabbitBindingRequest): void {
    const key = propertiesKeyOf(request.routingKey, { ...request.arguments });
    const known = this.bindings.some(
      (one) =>
        one.vhost === vhost &&
        one.source === request.source &&
        one.destination === request.destination &&
        one.destinationType === request.destinationType &&
        propertiesKeyOf(one.routingKey, one.arguments) === key,
    );
    if (!known) {
      this.bindings.push({
        vhost,
        source: request.source,
        destination: request.destination,
        destinationType: request.destinationType,
        routingKey: request.routingKey,
        ...(request.arguments === undefined ? {} : { arguments: { ...request.arguments } }),
      });
    }
  }

  /** Removes a binding by the broker's name for it; false when there is none. */
  unbind(
    vhost: string,
    source: string,
    destinationType: string,
    destination: string,
    propertiesKey: string,
  ): boolean {
    const index = this.bindings.findIndex(
      (one) =>
        one.vhost === vhost &&
        one.source === source &&
        one.destinationType === destinationType &&
        one.destination === destination &&
        propertiesKeyOf(one.routingKey, one.arguments) === propertiesKey,
    );
    if (index < 0) {
      return false;
    }
    this.bindings.splice(index, 1);
    return true;
  }

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
    message_stats: {
      publish_details: { rate: queue.rates?.publish ?? 1.5 },
      ...(queue.rates?.deliver === undefined
        ? {}
        : { deliver_get_details: { rate: queue.rates.deliver } }),
      ...(queue.rates?.ack === undefined ? {} : { ack_details: { rate: queue.rates.ack } }),
    },
    ...(queue.consumerDetails === undefined ? {} : { consumer_details: queue.consumerDetails }),
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
    properties_key: propertiesKeyOf(binding.routingKey, binding.arguments),
  };
}

function connectionJson(connection: FakeConnection): Record<string, unknown> {
  return {
    name: connection.name,
    user: connection.user ?? 'guest',
    vhost: connection.vhost,
    state: connection.state ?? 'running',
    protocol: 'AMQP 0-9-1',
    peer_host: connection.peerHost ?? '127.0.0.1',
    peer_port: connection.peerPort ?? 50_000,
    channels: connection.channels ?? 1,
    ...(connection.connectedAt === undefined ? {} : { connected_at: connection.connectedAt }),
    recv_oct: 1024,
    send_oct: 2048,
    client_properties: {
      ...(connection.clientName === undefined ? {} : { connection_name: connection.clientName }),
      product: connection.product ?? 'fake-client',
    },
  };
}

function policyJson(policy: FakeBroker['policies'][number]): Record<string, unknown> {
  return {
    vhost: policy.vhost,
    name: policy.name,
    pattern: policy.pattern,
    'apply-to': policy.applyTo,
    priority: policy.priority,
    definition: policy.definition,
  };
}

/** The management API over HTTP, on 127.0.0.1. */
export class FakeRabbitServer {
  readonly broker = new FakeBroker();
  readonly requests: RecordedRequest[] = [];
  user = 'guest';
  password = 'guest';
  /** False: the user lacks the administrator tag, so users and permissions answer 401. */
  administrator = true;
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
      answer(200, {
        rabbitmq_version: broker.version,
        cluster_name: broker.clusterName,
        ...broker.overview,
      });
      return;
    }
    if (kind === 'nodes' && method === 'GET') {
      answer(200, broker.nodes);
      return;
    }
    if (kind === 'global-parameters' && method === 'GET') {
      answer(200, broker.globalParameters);
      return;
    }
    if (kind === 'vhost-limits' && vhost !== undefined) {
      const limits = broker.vhostLimits.get(vhost) ?? {};
      if (name === undefined && method === 'GET') {
        answer(200, Object.keys(limits).length === 0 ? [] : [{ vhost, value: limits }]);
        return;
      }
      if (name !== undefined && method === 'PUT') {
        broker.vhostLimits.set(vhost, { ...limits, [name]: (body as { value: number }).value });
        answer(204);
        return;
      }
      if (name !== undefined && method === 'DELETE') {
        const { [name]: _gone, ...left } = limits;
        broker.vhostLimits.set(vhost, left);
        answer(204);
        return;
      }
    }
    if (kind === 'whoami') {
      answer(200, { name: this.user, tags: ['administrator'] });
      return;
    }
    if (kind === 'vhosts' && vhost !== undefined && name === 'connections') {
      answer(200, broker.connections.filter((c) => c.vhost === vhost).map(connectionJson));
      return;
    }
    if (kind === 'vhosts' && vhost !== undefined && name === 'permissions') {
      if (!this.administrator) {
        answer(401, { error: 'not_authorised', reason: 'This needs the administrator tag' });
        return;
      }
      answer(
        200,
        broker.permissions.filter((p) => p.vhost === vhost),
      );
      return;
    }
    if (kind === 'vhosts' && vhost !== undefined && method === 'PUT') {
      const existed = broker.vhosts.has(vhost);
      broker.vhosts.add(vhost);
      answer(existed ? 204 : 201);
      return;
    }
    if (kind === 'vhosts' && vhost !== undefined && method === 'DELETE') {
      if (broker.deleteVhost(vhost)) {
        answer(204);
      } else {
        answer(404, { error: 'Object Not Found', reason: 'Not Found' });
      }
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
    this.adminRoute(method, kind, vhost, name, rest, body, answer);
  }

  /** Bindings, connections, users, permissions and policies. */
  private adminRoute(
    method: string,
    kind: string | undefined,
    first: string | undefined,
    second: string | undefined,
    rest: string[],
    body: unknown,
    answer: (status: number, json?: unknown) => void,
  ): void {
    const broker = this.broker;
    const missing = (): void => {
      answer(404, { error: 'Object Not Found', reason: 'Not Found' });
    };
    if (kind === 'bindings' && first !== undefined) {
      // bindings/<vhost>/e/<source>/<q|e>/<destination>[/<properties key>]
      const source = rest[0];
      const type = rest[1];
      const destination = rest[2];
      const props = rest[3];
      if (second !== 'e' || source === undefined || destination === undefined) {
        missing();
        return;
      }
      const destinationType = type === 'q' ? 'queue' : 'exchange';
      if (method === 'POST' && props === undefined) {
        if (source === 'amq.default' || source === '') {
          // As the real broker does (checked against 3.13): a refusal of access, not a bad request.
          answer(401, { error: 'not_authorised', reason: 'Access refused.' });
          return;
        }
        const request = body as { routing_key: string; arguments: Record<string, unknown> };
        broker.bind(first, {
          source,
          destination,
          destinationType,
          routingKey: request.routing_key,
          arguments: request.arguments,
        });
        answer(201);
        return;
      }
      if (method === 'DELETE' && props !== undefined) {
        if (broker.unbind(first, source, destinationType, destination, props)) {
          answer(204);
        } else {
          missing();
        }
        return;
      }
      missing();
      return;
    }
    if (kind === 'connections' && first !== undefined && method === 'DELETE') {
      const index = broker.connections.findIndex((c) => c.name === first);
      if (index < 0) {
        missing();
      } else {
        broker.connections.splice(index, 1);
        answer(204);
      }
      return;
    }
    if (kind === 'users') {
      if (!this.administrator) {
        answer(401, { error: 'not_authorised', reason: 'This needs the administrator tag' });
        return;
      }
      if (first === undefined && method === 'GET') {
        answer(
          200,
          broker.users.map((u) => ({ name: u.name, tags: u.tags, password_hash: 'xx' })),
        );
      } else if (first !== undefined && method === 'GET') {
        const known = broker.users.find((u) => u.name === first);
        if (known === undefined) {
          missing();
        } else {
          answer(200, {
            name: known.name,
            tags: known.tags,
            password_hash: known.password === undefined ? '' : `h:${known.password}`,
            hashing_algorithm: 'fake_hash',
          });
        }
      } else if (first !== undefined && method === 'PUT') {
        const request = body as {
          password?: string;
          password_hash?: string;
          hashing_algorithm?: string;
          tags: string;
        };
        const tags = request.tags.split(',').filter((tag) => tag !== '');
        // As the real broker does (checked against 3.13): a PUT with neither a password nor a
        // hash leaves the user without a password.
        const password =
          request.password ??
          (request.password_hash?.startsWith('h:') === true
            ? request.password_hash.slice(2)
            : undefined);
        const known = broker.users.find((u) => u.name === first);
        if (known === undefined) {
          broker.users.push({ name: first, tags, ...(password === undefined ? {} : { password }) });
          answer(201);
        } else {
          known.tags = tags;
          if (password === undefined) {
            delete known.password;
          } else {
            known.password = password;
          }
          answer(204);
        }
      } else if (first !== undefined && method === 'DELETE') {
        const index = broker.users.findIndex((u) => u.name === first);
        if (index < 0) {
          missing();
        } else {
          broker.users.splice(index, 1);
          answer(204);
        }
      } else {
        missing();
      }
      return;
    }
    if (kind === 'permissions' && first !== undefined && second !== undefined) {
      const index = broker.permissions.findIndex((p) => p.vhost === first && p.user === second);
      if (method === 'PUT') {
        const request = body as { configure: string; write: string; read: string };
        const permission = { vhost: first, user: second, ...request };
        if (index < 0) {
          broker.permissions.push(permission);
          answer(201);
        } else {
          broker.permissions[index] = permission;
          answer(204);
        }
      } else if (method === 'DELETE') {
        if (index < 0) {
          missing();
        } else {
          broker.permissions.splice(index, 1);
          answer(204);
        }
      } else {
        missing();
      }
      return;
    }
    if (kind === 'policies' && first !== undefined) {
      if (second === undefined && method === 'GET') {
        answer(200, broker.policies.filter((p) => p.vhost === first).map(policyJson));
        return;
      }
      const index = broker.policies.findIndex((p) => p.vhost === first && p.name === second);
      if (second !== undefined && method === 'PUT') {
        const request = body as {
          pattern: string;
          definition: Record<string, unknown>;
          priority: number;
          'apply-to': string;
        };
        const policy = {
          vhost: first,
          name: second,
          pattern: request.pattern,
          applyTo: request['apply-to'],
          priority: request.priority,
          definition: request.definition,
        };
        if (index < 0) {
          broker.policies.push(policy);
          answer(201);
        } else {
          broker.policies[index] = policy;
          answer(204);
        }
        return;
      }
      if (second !== undefined && method === 'DELETE') {
        if (index < 0) {
          missing();
        } else {
          broker.policies.splice(index, 1);
          answer(204);
        }
        return;
      }
    }
    missing();
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

  createVhost(name: string): Promise<void> {
    this.note('createVhost');
    this.broker.vhosts.add(name);
    return Promise.resolve();
  }

  deleteVhost(name: string): Promise<void> {
    this.note('deleteVhost');
    if (!this.broker.deleteVhost(name)) {
      return Promise.reject(new DbError('not-found', 'Not Found'));
    }
    return Promise.resolve();
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
        propertiesKey: propertiesKeyOf(b.routingKey, b.arguments),
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

  bind(vhost: string, binding: RabbitBindingRequest): Promise<void> {
    this.note('bind');
    this.broker.bind(vhost, binding);
    return Promise.resolve();
  }

  unbind(vhost: string, binding: RabbitBinding): Promise<void> {
    this.note('unbind');
    this.broker.unbind(
      vhost,
      binding.source,
      binding.destinationType,
      binding.destination,
      binding.propertiesKey,
    );
    return Promise.resolve();
  }

  listConnections(vhost: string): Promise<RabbitPage<RabbitConnectionInfo>> {
    this.note('listConnections');
    const items = this.broker.connections
      .filter((c) => c.vhost === vhost)
      .map((c): RabbitConnectionInfo => ({
        name: c.name,
        user: c.user ?? 'guest',
        vhost: c.vhost,
        state: c.state ?? 'running',
        protocol: 'AMQP 0-9-1',
        peer: `${c.peerHost ?? '127.0.0.1'}:${c.peerPort ?? 50_000}`,
        channels: c.channels ?? 1,
        connectedAt: c.connectedAt,
        receivedBytes: 1024,
        sentBytes: 2048,
        clientName: c.clientName ?? '',
        product: c.product ?? 'fake-client',
      }));
    return Promise.resolve({ items, total: items.length + this.broker.extraTotal });
  }

  closeConnection(name: string): Promise<void> {
    this.note('closeConnection');
    const index = this.broker.connections.findIndex((c) => c.name === name);
    if (index >= 0) {
      this.broker.connections.splice(index, 1);
    }
    return Promise.resolve();
  }

  listUsers(): Promise<readonly RabbitUserInfo[]> {
    this.note('listUsers');
    return Promise.resolve(
      this.broker.users
        .map((u) => ({ name: u.name, tags: u.tags }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  createUser(user: {
    readonly name: string;
    readonly password: string;
    readonly tags: readonly string[];
  }): Promise<void> {
    this.note('createUser');
    this.broker.users.push({ name: user.name, tags: [...user.tags], password: user.password });
    return Promise.resolve();
  }

  updateUser(
    name: string,
    change: { readonly password?: string; readonly tags?: readonly string[] },
  ): Promise<void> {
    this.note('updateUser');
    const user = this.broker.users.find((u) => u.name === name);
    if (user === undefined) {
      return Promise.reject(new DbError('not-found', 'Not Found'));
    }
    if (change.tags !== undefined) {
      user.tags = [...change.tags];
    }
    if (change.password !== undefined) {
      user.password = change.password;
    }
    return Promise.resolve();
  }

  deleteUser(name: string): Promise<void> {
    this.note('deleteUser');
    const index = this.broker.users.findIndex((u) => u.name === name);
    if (index >= 0) {
      this.broker.users.splice(index, 1);
    }
    return Promise.resolve();
  }

  listPermissions(vhost: string): Promise<readonly RabbitPermissionInfo[]> {
    this.note('listPermissions');
    return Promise.resolve(this.broker.permissions.filter((p) => p.vhost === vhost));
  }

  setPermission(vhost: string, permission: RabbitPermissionInfo): Promise<void> {
    this.note('setPermission');
    const index = this.broker.permissions.findIndex(
      (p) => p.vhost === vhost && p.user === permission.user,
    );
    const stored = { vhost, ...permission };
    if (index < 0) {
      this.broker.permissions.push(stored);
    } else {
      this.broker.permissions[index] = stored;
    }
    return Promise.resolve();
  }

  clearPermission(vhost: string, user: string): Promise<void> {
    this.note('clearPermission');
    const index = this.broker.permissions.findIndex((p) => p.vhost === vhost && p.user === user);
    if (index >= 0) {
      this.broker.permissions.splice(index, 1);
    }
    return Promise.resolve();
  }

  listPolicies(vhost: string): Promise<readonly RabbitPolicyInfo[]> {
    this.note('listPolicies');
    return Promise.resolve(
      this.broker.policies
        .filter((p) => p.vhost === vhost)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  setPolicy(policy: RabbitPolicyDeclaration): Promise<void> {
    this.note('setPolicy');
    const index = this.broker.policies.findIndex(
      (p) => p.vhost === policy.vhost && p.name === policy.name,
    );
    const stored = { ...policy, definition: { ...policy.definition } };
    if (index < 0) {
      this.broker.policies.push(stored);
    } else {
      this.broker.policies[index] = stored;
    }
    return Promise.resolve();
  }

  deletePolicy(vhost: string, name: string): Promise<void> {
    this.note('deletePolicy');
    const index = this.broker.policies.findIndex((p) => p.vhost === vhost && p.name === name);
    if (index >= 0) {
      this.broker.policies.splice(index, 1);
    }
    return Promise.resolve();
  }

  readCluster(): Promise<RabbitClusterInfo> {
    this.note('readCluster');
    const { overview } = this.broker;
    const totals = (overview.object_totals ?? {}) as Record<string, number>;
    const queueTotals = (overview.queue_totals ?? {}) as Record<string, number>;
    return Promise.resolve({
      clusterName: this.broker.clusterName,
      version: this.broker.version,
      erlang: typeof overview.erlang_version === 'string' ? overview.erlang_version : '',
      node: typeof overview.node === 'string' ? overview.node : '',
      queues: totals.queues ?? 0,
      exchanges: totals.exchanges ?? 0,
      connections: totals.connections ?? 0,
      channels: totals.channels ?? 0,
      consumers: totals.consumers ?? 0,
      ready: queueTotals.messages_ready ?? 0,
      unacked: queueTotals.messages_unacknowledged ?? 0,
      listeners: (
        (overview.listeners ?? []) as {
          protocol: string;
          ip_address: string;
          port: number;
          node: string;
        }[]
      ).map((listener) => ({
        protocol: listener.protocol,
        ip: listener.ip_address,
        port: listener.port,
        node: listener.node,
      })),
      nodes: this.broker.nodes.map(nodeOf),
    });
  }

  listGlobalParameters(): Promise<readonly RabbitGlobalParameter[]> {
    this.note('listGlobalParameters');
    return Promise.resolve(this.broker.globalParameters.map((one) => ({ ...one })));
  }

  listVhostLimits(vhost: string): Promise<RabbitVhostLimits> {
    this.note('listVhostLimits');
    const limits = this.broker.vhostLimits.get(vhost) ?? {};
    return Promise.resolve({
      ...(limits['max-connections'] === undefined
        ? {}
        : { maxConnections: limits['max-connections'] }),
      ...(limits['max-queues'] === undefined ? {} : { maxQueues: limits['max-queues'] }),
    });
  }

  setVhostLimit(vhost: string, name: VhostLimitName, value: number): Promise<void> {
    this.note('setVhostLimit');
    this.broker.vhostLimits.set(vhost, {
      ...(this.broker.vhostLimits.get(vhost) ?? {}),
      [name]: value,
    });
    return Promise.resolve();
  }

  clearVhostLimit(vhost: string, name: VhostLimitName): Promise<void> {
    this.note('clearVhostLimit');
    const { [name]: _gone, ...left } = this.broker.vhostLimits.get(vhost) ?? {};
    this.broker.vhostLimits.set(vhost, left);
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
    incomingRate: queue.rates?.publish ?? 1.5,
    ...(queue.rates?.deliver === undefined ? {} : { deliverRate: queue.rates.deliver }),
    ...(queue.rates?.ack === undefined ? {} : { ackRate: queue.rates.ack }),
    node: 'rabbit@fake',
    consumerDetails: (queue.consumerDetails ?? []).map(consumerOf),
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

// A RabbitMQ session over Node's own HTTP client (V13.26): an agent of its own, TLS with
// DataNest's rules and basic authentication, against the management plugin's API. The API
// is plain JSON over HTTP, so no AMQP client is needed (D156).

import * as http from 'node:http';
import * as https from 'node:https';
import { DbError, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  effectivePort,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { identityCheck, sniName, tlsFailure, tlsMaterial, type TlsMaterial } from '../common/tls';
import type {
  RabbitBinding,
  RabbitBindingRequest,
  RabbitClusterInfo,
  RabbitConnectionInfo,
  RabbitConsumerInfo,
  RabbitExchangeDeclaration,
  RabbitExchangeInfo,
  RabbitGlobalParameter,
  RabbitListener,
  RabbitMessage,
  RabbitNodeInfo,
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
} from '../rabbitmq-driver';
import { networkFailure, rabbitFailure } from './errors';

/** Bytes of an answer DataNest reads at most; a bigger one is refused, not cut. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Connections each session keeps open at most. */
const MAX_SOCKETS = 4;

/** Queues or exchanges one listing asks the broker for; the rest is counted, not read. */
export const PAGE_SIZE = 500;

/** Milliseconds a request may take in all. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The user RabbitMQ creates by default, used when the connection names none. */
const DEFAULT_USER = 'guest';

/** The default exchange has the empty name; the API calls it this. */
const DEFAULT_EXCHANGE = 'amq.default';

export interface RabbitTarget {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** Only this virtual host is shown; empty: every one the user may see. */
  readonly vhost: string;
  readonly tls?: https.AgentOptions;
  readonly connectTimeoutMs: number;
}

/** Where and how to send requests: the host, the credentials, TLS. */
export function rabbitTarget(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): RabbitTarget {
  const servername = tls === undefined ? undefined : sniName(tls.serverName);
  const user = config.user?.trim() ?? '';
  return {
    secure: tls !== undefined,
    host: config.host?.trim() ?? 'localhost',
    port: effectivePort(config) ?? DEFAULT_PORTS.rabbitmq ?? 15672,
    user: user === '' ? DEFAULT_USER : user,
    password: config.password ?? '',
    vhost: config.database?.trim() ?? '',
    connectTimeoutMs: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
    ...(tls === undefined
      ? {}
      : {
          tls: {
            ...(tls.ca === undefined ? {} : { ca: tls.ca }),
            ...(tls.cert === undefined ? {} : { cert: tls.cert }),
            ...(tls.key === undefined ? {} : { key: tls.key }),
            rejectUnauthorized: tls.mode !== 'require',
            checkServerIdentity: identityCheck(tls),
            ...(servername === undefined ? {} : { servername }),
          },
        }),
  };
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function flag(value: unknown): boolean {
  return value === true;
}

/** `"name"` of a policy, which the API leaves out (or sets to null) when there is none. */
function policyName(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The tags of a user: a list, or the comma-separated text older brokers send. */
export function tagsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((tag): tag is string => typeof tag === 'string');
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }
  return [];
}

export function consumerOf(raw: unknown): RabbitConsumerInfo {
  const consumer = asObject(raw);
  const channel = asObject(consumer.channel_details);
  return {
    tag: text(consumer.consumer_tag),
    connectionName: text(channel.connection_name),
    channel: text(channel.name),
    user: text(channel.user),
    prefetch: count(consumer.prefetch_count),
    ackRequired: flag(consumer.ack_required),
    exclusive: flag(consumer.exclusive),
    active: consumer.active !== false,
  };
}

export function queueOf(raw: unknown, vhostFallback = ''): RabbitQueueInfo {
  const queue = asObject(raw);
  const args = asObject(queue.arguments);
  const stats = asObject(queue.message_stats);
  const rate = asObject(stats.publish_details).rate;
  const deliverRate = asObject(stats.deliver_get_details).rate;
  const ackRate = asObject(stats.ack_details).rate;
  const declaredType = text(queue.type) || text(args['x-queue-type']);
  return {
    vhost: text(queue.vhost) || vhostFallback,
    name: text(queue.name),
    type: declaredType,
    durable: flag(queue.durable),
    autoDelete: flag(queue.auto_delete),
    exclusive: flag(queue.exclusive),
    state: text(queue.state),
    ready: count(queue.messages_ready),
    unacked: count(queue.messages_unacknowledged),
    total: count(queue.messages),
    consumers: count(queue.consumers),
    memory: count(queue.memory),
    policy: policyName(queue.policy),
    arguments: args,
    incomingRate: typeof rate === 'number' ? rate : undefined,
    ...(typeof deliverRate === 'number' ? { deliverRate } : {}),
    ...(typeof ackRate === 'number' ? { ackRate } : {}),
    node: text(queue.node),
    consumerDetails: (Array.isArray(queue.consumer_details) ? queue.consumer_details : []).map(
      consumerOf,
    ),
  };
}

export function exchangeOf(raw: unknown, vhostFallback = ''): RabbitExchangeInfo {
  const exchange = asObject(raw);
  return {
    vhost: text(exchange.vhost) || vhostFallback,
    name: text(exchange.name),
    type: text(exchange.type),
    durable: flag(exchange.durable),
    autoDelete: flag(exchange.auto_delete),
    internal: flag(exchange.internal),
    policy: policyName(exchange.policy),
    arguments: asObject(exchange.arguments),
  };
}

export function bindingOf(raw: unknown): RabbitBinding {
  const binding = asObject(raw);
  return {
    source: text(binding.source),
    destination: text(binding.destination),
    destinationType: binding.destination_type === 'exchange' ? 'exchange' : 'queue',
    routingKey: text(binding.routing_key),
    arguments: asObject(binding.arguments),
    propertiesKey: text(binding.properties_key),
  };
}

export function connectionOf(raw: unknown): RabbitConnectionInfo {
  const connection = asObject(raw);
  const client = asObject(connection.client_properties);
  const host = text(connection.peer_host);
  const port = count(connection.peer_port);
  return {
    name: text(connection.name),
    user: text(connection.user),
    vhost: text(connection.vhost),
    state: text(connection.state),
    protocol: text(connection.protocol),
    peer: host === '' ? '' : port > 0 ? `${host}:${port}` : host,
    channels: count(connection.channels),
    connectedAt: typeof connection.connected_at === 'number' ? connection.connected_at : undefined,
    receivedBytes: count(connection.recv_oct),
    sentBytes: count(connection.send_oct),
    clientName: text(client.connection_name),
    product: text(client.product),
  };
}

export function policyOf(raw: unknown): RabbitPolicyInfo {
  const policy = asObject(raw);
  return {
    name: text(policy.name),
    pattern: text(policy.pattern),
    applyTo: text(policy['apply-to']) || 'all',
    priority: count(policy.priority),
    definition: asObject(policy.definition),
  };
}

function permissionOf(raw: unknown): RabbitPermissionInfo {
  const permission = asObject(raw);
  return {
    user: text(permission.user),
    configure: text(permission.configure),
    write: text(permission.write),
    read: text(permission.read),
  };
}

export function nodeOf(raw: unknown): RabbitNodeInfo {
  const node = asObject(raw);
  return {
    name: text(node.name),
    type: text(node.type),
    running: flag(node.running),
    uptimeMs: count(node.uptime),
    memUsed: count(node.mem_used),
    memLimit: count(node.mem_limit),
    memAlarm: flag(node.mem_alarm),
    diskFree: count(node.disk_free),
    diskFreeLimit: count(node.disk_free_limit),
    diskAlarm: flag(node.disk_free_alarm),
    fdUsed: count(node.fd_used),
    fdTotal: count(node.fd_total),
    socketsUsed: count(node.sockets_used),
    socketsTotal: count(node.sockets_total),
    procUsed: count(node.proc_used),
    procTotal: count(node.proc_total),
    processors: count(node.processors),
    partitions: (Array.isArray(node.partitions) ? node.partitions : []).filter(
      (one): one is string => typeof one === 'string',
    ),
    draining: flag(node.being_drained),
  };
}

function listenerOf(raw: unknown): RabbitListener {
  const listener = asObject(raw);
  return {
    protocol: text(listener.protocol),
    ip: text(listener.ip_address),
    port: count(listener.port),
    node: text(listener.node),
  };
}

/** The most connections one listing reads; the rest is counted. */
export const MAX_CONNECTIONS = 500;

/** A listing is a page object when asked with `page`, a plain array on very old brokers. */
function pageOf<T>(raw: unknown, read: (item: unknown) => T): RabbitPage<T> {
  if (Array.isArray(raw)) {
    return { items: raw.map(read), total: raw.length };
  }
  const page = asObject(raw);
  const items = Array.isArray(page.items) ? page.items.map(read) : [];
  const total = count(page.total_count) || count(page.filtered_count) || items.length;
  return { items, total: Math.max(total, items.length) };
}

function messageOf(raw: unknown): RabbitMessage {
  const message = asObject(raw);
  const payload = text(message.payload);
  // The request asks for base64; a broker that answered otherwise sent the text as it is.
  const bytes =
    message.payload_encoding === 'base64'
      ? Uint8Array.from(Buffer.from(payload, 'base64'))
      : Uint8Array.from(Buffer.from(payload, 'utf8'));
  return {
    payload: bytes,
    payloadBytes: count(message.payload_bytes) || bytes.length,
    redelivered: flag(message.redelivered),
    exchange: text(message.exchange),
    routingKey: text(message.routing_key),
    messagesLeft: count(message.message_count),
    properties: asObject(message.properties),
  };
}

const enc = encodeURIComponent;

interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

class ManagementSession implements RabbitSession {
  server: RabbitServerInfo = { version: '', clusterName: '', user: '' };
  private readonly agent: http.Agent;
  private readonly authorization: string;
  private closed = false;

  constructor(
    private readonly target: RabbitTarget,
    private readonly serverName: string | undefined,
  ) {
    // No keep-alive: the management plugin closes idle connections at moments of its own,
    // and a request sent down a connection it just closed fails with a hang-up, even a
    // publish that must never be sent twice. A new connection per request costs little at
    // the rate a person browses (D156).
    this.agent = target.secure
      ? new https.Agent({ keepAlive: false, maxSockets: MAX_SOCKETS, ...target.tls })
      : new http.Agent({ keepAlive: false, maxSockets: MAX_SOCKETS });
    this.authorization = `Basic ${Buffer.from(`${target.user}:${target.password}`, 'utf8').toString('base64')}`;
  }

  /** Reads who the broker is and who we are; this proves the address and the login. */
  async readServer(): Promise<RabbitServerInfo> {
    const overview = asObject(await this.call('GET', 'overview'));
    const who = asObject(await this.call('GET', 'whoami'));
    const version = text(overview.rabbitmq_version);
    if (version === '') {
      throw new DbError(
        'connection-failed',
        msg('The server did not answer as RabbitMQ does: no version'),
      );
    }
    return {
      version,
      clusterName: text(overview.cluster_name),
      user: text(who.name) || this.target.user,
    };
  }

  async listVhosts(): Promise<readonly RabbitVhostInfo[]> {
    if (this.target.vhost !== '') {
      const one = asObject(await this.call('GET', `vhosts/${enc(this.target.vhost)}`));
      return [{ name: text(one.name) || this.target.vhost, messages: count(one.messages) }];
    }
    const raw = await this.call('GET', 'vhosts');
    return (Array.isArray(raw) ? raw : [])
      .map((item) => asObject(item))
      .map((vhost) => ({ name: text(vhost.name), messages: count(vhost.messages) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createVhost(name: string): Promise<void> {
    await this.call('PUT', `vhosts/${enc(name)}`);
  }

  async deleteVhost(name: string): Promise<void> {
    await this.call('DELETE', `vhosts/${enc(name)}`);
  }

  async listQueues(vhost: string): Promise<RabbitPage<RabbitQueueInfo>> {
    const raw = await this.call(
      'GET',
      `queues/${enc(vhost)}?page=1&page_size=${PAGE_SIZE}&sort=name`,
    );
    return pageOf(raw, (item) => queueOf(item, vhost));
  }

  async listExchanges(vhost: string): Promise<RabbitPage<RabbitExchangeInfo>> {
    const raw = await this.call(
      'GET',
      `exchanges/${enc(vhost)}?page=1&page_size=${PAGE_SIZE}&sort=name`,
    );
    return pageOf(raw, (item) => exchangeOf(item, vhost));
  }

  async getQueue(vhost: string, name: string): Promise<RabbitQueueInfo> {
    return queueOf(await this.call('GET', `queues/${enc(vhost)}/${enc(name)}`), vhost);
  }

  async getExchange(vhost: string, name: string): Promise<RabbitExchangeInfo> {
    const raw = await this.call('GET', `exchanges/${enc(vhost)}/${enc(exchangeKey(name))}`);
    return exchangeOf(raw, vhost);
  }

  async listBindings(
    vhost: string,
    target: { readonly queue: string } | { readonly exchange: string },
  ): Promise<readonly RabbitBinding[]> {
    const lists = async (paths: readonly string[]): Promise<RabbitBinding[]> => {
      const found: RabbitBinding[] = [];
      for (const path of paths) {
        const raw = await this.call('GET', path);
        for (const item of Array.isArray(raw) ? raw : []) {
          found.push(bindingOf(item));
        }
      }
      return found;
    };
    if ('queue' in target) {
      return await lists([`queues/${enc(vhost)}/${enc(target.queue)}/bindings`]);
    }
    const key = enc(exchangeKey(target.exchange));
    return await lists([
      `exchanges/${enc(vhost)}/${key}/bindings/source`,
      `exchanges/${enc(vhost)}/${key}/bindings/destination`,
    ]);
  }

  async peekMessages(request: RabbitPeekRequest): Promise<readonly RabbitMessage[]> {
    const raw = await this.call(
      'POST',
      `queues/${enc(request.vhost)}/${enc(request.queue)}/get`,
      {
        count: Math.max(1, Math.trunc(request.count)),
        // Fetched and put back at once: a peek must never take a message from its queue.
        ackmode: 'ack_requeue_true',
        encoding: 'base64',
        truncate: Math.max(1, Math.trunc(request.maxBytes)),
      },
      { signal: request.signal },
    );
    return (Array.isArray(raw) ? raw : []).map(messageOf);
  }

  async publish(request: RabbitPublishRequest): Promise<boolean> {
    const raw = asObject(
      await this.call(
        'POST',
        `exchanges/${enc(request.vhost)}/${enc(exchangeKey(request.exchange))}/publish`,
        {
          properties: request.properties ?? {},
          routing_key: request.routingKey,
          payload: Buffer.from(request.payload).toString('base64'),
          payload_encoding: 'base64',
        },
      ),
    );
    return raw.routed === true;
  }

  async declareQueue(declaration: RabbitQueueDeclaration): Promise<void> {
    await this.call('PUT', `queues/${enc(declaration.vhost)}/${enc(declaration.name)}`, {
      durable: declaration.durable,
      auto_delete: declaration.autoDelete,
      arguments:
        declaration.type === undefined || declaration.type === 'classic'
          ? {}
          : { 'x-queue-type': declaration.type },
    });
  }

  async deleteQueue(vhost: string, name: string): Promise<void> {
    await this.call('DELETE', `queues/${enc(vhost)}/${enc(name)}`);
  }

  async purgeQueue(vhost: string, name: string): Promise<void> {
    await this.call('DELETE', `queues/${enc(vhost)}/${enc(name)}/contents`);
  }

  async declareExchange(declaration: RabbitExchangeDeclaration): Promise<void> {
    await this.call('PUT', `exchanges/${enc(declaration.vhost)}/${enc(declaration.name)}`, {
      type: declaration.type,
      durable: declaration.durable,
      auto_delete: declaration.autoDelete,
      internal: declaration.internal,
      arguments: {},
    });
  }

  async deleteExchange(vhost: string, name: string): Promise<void> {
    await this.call('DELETE', `exchanges/${enc(vhost)}/${enc(name)}`);
  }

  async bind(vhost: string, binding: RabbitBindingRequest): Promise<void> {
    await this.call(
      'POST',
      `bindings/${enc(vhost)}/e/${enc(binding.source)}/${binding.destinationType === 'queue' ? 'q' : 'e'}/${enc(binding.destination)}`,
      { routing_key: binding.routingKey, arguments: binding.arguments ?? {} },
    );
  }

  async unbind(vhost: string, binding: RabbitBinding): Promise<void> {
    // The broker's name for the binding is quoted already, and the path quotes it once more.
    await this.call(
      'DELETE',
      `bindings/${enc(vhost)}/e/${enc(binding.source)}/${binding.destinationType === 'queue' ? 'q' : 'e'}/${enc(binding.destination)}/${enc(binding.propertiesKey)}`,
    );
  }

  async listConnections(vhost: string): Promise<RabbitPage<RabbitConnectionInfo>> {
    const raw = await this.call('GET', `vhosts/${enc(vhost)}/connections`);
    const all = Array.isArray(raw) ? raw : [];
    return { items: all.slice(0, MAX_CONNECTIONS).map(connectionOf), total: all.length };
  }

  async closeConnection(name: string): Promise<void> {
    await this.call('DELETE', `connections/${enc(name)}`);
  }

  async listUsers(): Promise<readonly RabbitUserInfo[]> {
    const raw = await this.call('GET', 'users');
    return (Array.isArray(raw) ? raw : [])
      .map((item) => asObject(item))
      .map((user) => ({
        name: text(user.name),
        tags: tagsOf(user.tags),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createUser(user: {
    readonly name: string;
    readonly password: string;
    readonly tags: readonly string[];
  }): Promise<void> {
    await this.call('PUT', `users/${enc(user.name)}`, {
      password: user.password,
      tags: user.tags.join(','),
    });
  }

  /**
   * Changes the password, the tags or both of an existing user. The broker's PUT without a
   * password wipes it (checked against 3.13: the old password stops working), so a change of
   * tags alone sends back the stored hash and its algorithm, and a change of the password
   * alone sends the tags the user has now.
   */
  async updateUser(
    name: string,
    change: { readonly password?: string; readonly tags?: readonly string[] },
  ): Promise<void> {
    const current = asObject(await this.call('GET', `users/${enc(name)}`));
    const tags = change.tags ?? tagsOf(current.tags);
    if (change.password !== undefined) {
      await this.call('PUT', `users/${enc(name)}`, {
        password: change.password,
        tags: tags.join(','),
      });
      return;
    }
    await this.call('PUT', `users/${enc(name)}`, {
      password_hash: text(current.password_hash),
      hashing_algorithm: text(current.hashing_algorithm),
      tags: tags.join(','),
    });
  }

  async deleteUser(name: string): Promise<void> {
    await this.call('DELETE', `users/${enc(name)}`);
  }

  async listPermissions(vhost: string): Promise<readonly RabbitPermissionInfo[]> {
    const raw = await this.call('GET', `vhosts/${enc(vhost)}/permissions`);
    return (Array.isArray(raw) ? raw : [])
      .map(permissionOf)
      .sort((a, b) => a.user.localeCompare(b.user));
  }

  async setPermission(vhost: string, permission: RabbitPermissionInfo): Promise<void> {
    await this.call('PUT', `permissions/${enc(vhost)}/${enc(permission.user)}`, {
      configure: permission.configure,
      write: permission.write,
      read: permission.read,
    });
  }

  async clearPermission(vhost: string, user: string): Promise<void> {
    await this.call('DELETE', `permissions/${enc(vhost)}/${enc(user)}`);
  }

  async listPolicies(vhost: string): Promise<readonly RabbitPolicyInfo[]> {
    const raw = await this.call('GET', `policies/${enc(vhost)}`);
    return (Array.isArray(raw) ? raw : [])
      .map(policyOf)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setPolicy(policy: RabbitPolicyDeclaration): Promise<void> {
    await this.call('PUT', `policies/${enc(policy.vhost)}/${enc(policy.name)}`, {
      pattern: policy.pattern,
      definition: policy.definition,
      priority: policy.priority,
      'apply-to': policy.applyTo,
    });
  }

  async deletePolicy(vhost: string, name: string): Promise<void> {
    await this.call('DELETE', `policies/${enc(vhost)}/${enc(name)}`);
  }

  async readCluster(): Promise<RabbitClusterInfo> {
    const overview = asObject(await this.call('GET', 'overview'));
    const totals = asObject(overview.object_totals);
    const queueTotals = asObject(overview.queue_totals);
    const nodes = await this.call('GET', 'nodes');
    return {
      clusterName: text(overview.cluster_name),
      version: text(overview.rabbitmq_version),
      erlang: text(overview.erlang_version),
      node: text(overview.node),
      queues: count(totals.queues),
      exchanges: count(totals.exchanges),
      connections: count(totals.connections),
      channels: count(totals.channels),
      consumers: count(totals.consumers),
      ready: count(queueTotals.messages_ready),
      unacked: count(queueTotals.messages_unacknowledged),
      listeners: (Array.isArray(overview.listeners) ? overview.listeners : []).map(listenerOf),
      nodes: (Array.isArray(nodes) ? nodes : [])
        .map(nodeOf)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async listGlobalParameters(): Promise<readonly RabbitGlobalParameter[]> {
    const raw = await this.call('GET', 'global-parameters');
    return (Array.isArray(raw) ? raw : [])
      .map((item) => asObject(item))
      .map((parameter) => ({ name: text(parameter.name), value: parameter.value }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listVhostLimits(vhost: string): Promise<RabbitVhostLimits> {
    const raw = await this.call('GET', `vhost-limits/${enc(vhost)}`);
    const value = asObject(asObject((Array.isArray(raw) ? raw : [])[0]).value);
    // A negative figure is the broker's way of saying there is no limit.
    const limit = (name: VhostLimitName): number | undefined => {
      const one = value[name];
      return typeof one === 'number' && Number.isFinite(one) && one >= 0 ? one : undefined;
    };
    const maxConnections = limit('max-connections');
    const maxQueues = limit('max-queues');
    return {
      ...(maxConnections === undefined ? {} : { maxConnections }),
      ...(maxQueues === undefined ? {} : { maxQueues }),
    };
  }

  async setVhostLimit(vhost: string, name: VhostLimitName, value: number): Promise<void> {
    await this.call('PUT', `vhost-limits/${enc(vhost)}/${name}`, { value });
  }

  async clearVhostLimit(vhost: string, name: VhostLimitName): Promise<void> {
    await this.call('DELETE', `vhost-limits/${enc(vhost)}/${name}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.agent.destroy();
    await Promise.resolve();
  }

  /** One request to `/api/<path>`; the answer is parsed JSON, or `{}` when it has no body. */
  call(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new DbError('connection-failed', msg('The session is closed')));
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const send = this.target.secure ? https.request : http.request;
      const outgoing = send(
        {
          host: this.target.host,
          port: this.target.port,
          method,
          path: `/api/${path}`,
          agent: this.agent,
          headers: {
            // Purging a queue answers 406 to a request that asks for JSON: it has no body to give.
            ...(method === 'GET' || method === 'POST' ? { accept: 'application/json' } : {}),
            authorization: this.authorization,
            ...(payload === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              incoming.destroy();
              clearTimeout(timer);
              reject(
                new DbError(
                  'constraint',
                  msg(
                    'The answer is larger than {0} MB: ask for less',
                    MAX_RESPONSE_BYTES / 1024 / 1024,
                  ),
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            clearTimeout(timer);
            const status = incoming.statusCode ?? 0;
            const answer = Buffer.concat(chunks).toString('utf8');
            if (status >= 400) {
              reject(rabbitFailure(status, answer));
              return;
            }
            try {
              resolve(answer.trim() === '' ? {} : (JSON.parse(answer) as unknown));
            } catch (error) {
              reject(
                new DbError(
                  'connection-failed',
                  msg('The server did not answer as RabbitMQ does: {0}', errorMessage(error)),
                  { cause: error },
                ),
              );
            }
          });
          incoming.on('error', (error) => {
            clearTimeout(timer);
            reject(networkFailure(error));
          });
        },
      );
      // Connecting has its own limit; a slow answer only the call's.
      outgoing.setTimeout(this.target.connectTimeoutMs, () => {
        if (!outgoing.reusedSocket && outgoing.socket?.connecting !== false) {
          outgoing.destroy(
            Object.assign(new Error(`connect ETIMEDOUT ${this.target.host}:${this.target.port}`), {
              code: 'ETIMEDOUT',
            }),
          );
        }
      });
      const limit = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        outgoing.destroy(
          new DbError('timeout', msg('The request took longer than {0} s', limit / 1000)),
        );
      }, limit);
      const abort = (): void => {
        clearTimeout(timer);
        outgoing.destroy(new DbError('cancelled', msg('The request was cancelled')));
      };
      if (options.signal?.aborted === true) {
        abort();
      } else {
        options.signal?.addEventListener('abort', abort, { once: true });
        outgoing.once('close', () => {
          options.signal?.removeEventListener('abort', abort);
        });
      }
      outgoing.on('error', (error) => {
        clearTimeout(timer);
        if (error instanceof DbError) {
          reject(error);
          return;
        }
        reject(
          (this.serverName === undefined ? undefined : tlsFailure(error, this.serverName)) ??
            networkFailure(error),
        );
      });
      outgoing.end(payload);
    });
  }
}

/** The API calls the default exchange (empty name) `amq.default`. */
function exchangeKey(name: string): string {
  return name === '' ? DEFAULT_EXCHANGE : name;
}

export async function openRabbitSession(config: ResolvedConnectionConfig): Promise<RabbitSession> {
  const tls = await tlsMaterial(config);
  const session = new ManagementSession(rabbitTarget(config, tls), tls?.serverName);
  try {
    session.server = await session.readServer();
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

// What the RabbitMQ queue, exchange and virtual host page (V13.26, V13.28) shows and does, free
// of `vscode`: it reads the figures, bindings and consumers of one queue or exchange, makes and
// removes bindings, peeks at the first messages of a queue and publishes a message; for a
// virtual host it lists connections, users with their permissions and policies and changes them. A peek never takes a message from its queue: the
// session fetches and puts back (D156), and a queue it does not know is an error, not an
// empty list.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type {
  RabbitBinding,
  RabbitBindingRequest,
  RabbitExchangeInfo,
  RabbitMessage,
  RabbitQueueInfo,
  RabbitSession,
  VhostLimitName,
} from '../../drivers/rabbitmq-driver';
import { formatSize } from '../../shared/byte-size';
import {
  DEFAULT_RABBIT_PEEK,
  MAX_RABBIT_PEEK,
  type RabbitAdminView,
  type RabbitBindingDirection,
  type RabbitFactView,
  type RabbitMessageView,
  type RabbitObjectKind,
  type RabbitObjectState,
  type RabbitSampleView,
  MAX_RABBIT_SAMPLES,
  RABBIT_QUEUE_TYPES,
  RABBIT_VHOST_LIMITS,
} from '../../shared/protocols/rabbitmq-object';
import { redisValueBytes, type RedisValue, redisValueOf } from '../../shared/redis-value';

/** Bytes of one payload the page shows; the rest is cut and says so. */
export const MAX_SHOWN_BYTES = 256 * 1024;

/** Bytes a peek brings at most, all messages together. */
export const MAX_PEEK_BYTES = 8 * 1024 * 1024;

/** Bindings the page lists; more are counted. */
export const MAX_BINDINGS = 500;

/** Milliseconds between two readings of the live graphs; the broker's own figures refresh about every 5 s. */
export const LIVE_INTERVAL_MS = 4000;

export interface RabbitObjectModelDeps {
  readonly kind: RabbitObjectKind;
  readonly vhost: string;
  /** Empty for the default exchange. */
  readonly name: string;
  readonly connectionName: string;
  readonly readOnly: boolean;
  /** The session of the object's connection. */
  readonly session: () => Promise<RabbitSession>;
}

/** The default exchange has no name; the API and the page also call it this. */
const DEFAULT_EXCHANGE_NAMES = new Set(['', 'amq.default']);

/** What a policy may apply to, as the broker words it. */
const POLICY_TARGETS = ['all', 'queues', 'classic_queues', 'quorum_queues', 'streams', 'exchanges'];

export interface RabbitBindingParams {
  readonly direction: RabbitBindingDirection;
  /** The other end: a queue or an exchange, by name. */
  readonly peer: string;
  readonly routingKey: string;
  /** A JSON object, or empty for none. */
  readonly arguments: string;
}

export interface RabbitPolicyParams {
  readonly name: string;
  readonly pattern: string;
  readonly applyTo: string;
  readonly priority: number;
  /** A JSON object. */
  readonly definition: string;
  /** An operator policy (V13.39). */
  readonly operator?: boolean;
}

/** `2026-11-02 10:15:00 UTC`; empty when the broker did not say. */
function timeText(ms: number | undefined): string {
  return ms === undefined ? '' : `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** How long a node has been up, in words: `3 d 4 h`, `2 h 5 min`, `40 s`. */
export function uptimeText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return msg('{0} d {1} h', days, hours);
  }
  if (hours > 0) {
    return msg('{0} h {1} min', hours, minutes);
  }
  if (minutes > 0) {
    return msg('{0} min {1} s', minutes, seconds % 60);
  }
  return msg('{0} s', seconds);
}

/** Reads a JSON object typed by a person; empty text is an empty object. */
export function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (text.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DbError('syntax', msg('{0} is not valid JSON', what));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DbError('syntax', msg('{0} must be a JSON object', what));
  }
  return parsed as Record<string, unknown>;
}

/** What is wrong with a pattern of names (a regular expression), or undefined. */
function patternProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'u');
    return undefined;
  } catch {
    return msg('"{0}" is not a valid regular expression', pattern);
  }
}

export interface RabbitPublishParams {
  readonly routingKey: string;
  readonly payload: RedisValue;
  readonly contentType?: string | undefined;
  readonly persistent: boolean;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}

const yes = (value: boolean): string => (value ? msg('yes') : msg('no'));

function jsonText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function factsOf(entries: Readonly<Record<string, unknown>>): RabbitFactView[] {
  return Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value: jsonText(value) }));
}

export function messageViewOf(message: RabbitMessage): RabbitMessageView {
  return {
    payload: redisValueOf(message.payload, MAX_SHOWN_BYTES, message.payloadBytes),
    payloadBytes: message.payloadBytes,
    redelivered: message.redelivered,
    exchange: message.exchange,
    routingKey: message.routingKey,
    messagesLeft: message.messagesLeft,
    properties: JSON.stringify(message.properties, null, 2),
  };
}

function queueFacts(queue: RabbitQueueInfo): RabbitFactView[] {
  const facts: RabbitFactView[] = [
    { key: msg('Type'), value: queue.type === '' ? msg('classic') : queue.type },
    { key: msg('State'), value: queue.state },
    { key: msg('Durable'), value: yes(queue.durable) },
    { key: msg('Auto-delete'), value: yes(queue.autoDelete) },
    { key: msg('Exclusive'), value: yes(queue.exclusive) },
    { key: msg('Consumers'), value: String(queue.consumers) },
  ];
  if (queue.memory > 0) {
    facts.push({ key: msg('Memory'), value: formatSize(queue.memory) });
  }
  if (queue.incomingRate !== undefined) {
    facts.push({ key: msg('Published per second'), value: String(queue.incomingRate) });
  }
  if (queue.policy !== '') {
    facts.push({ key: msg('Policy'), value: queue.policy });
  }
  if (queue.node !== '') {
    facts.push({ key: msg('Node'), value: queue.node });
  }
  return facts;
}

function exchangeFacts(exchange: RabbitExchangeInfo): RabbitFactView[] {
  const facts: RabbitFactView[] = [
    { key: msg('Type'), value: exchange.type },
    { key: msg('Durable'), value: yes(exchange.durable) },
    { key: msg('Auto-delete'), value: yes(exchange.autoDelete) },
    { key: msg('Internal'), value: yes(exchange.internal) },
  ];
  if (exchange.policy !== '') {
    facts.push({ key: msg('Policy'), value: exchange.policy });
  }
  return facts;
}

export class RabbitObjectModel {
  private current: Omit<RabbitObjectState, 'messages' | 'peeked' | 'count' | 'notice'>;
  private bindingList: readonly RabbitBinding[] = [];
  private messages: RabbitMessageView[] = [];
  private count = DEFAULT_RABBIT_PEEK;
  private peeked = false;
  private notice: string | undefined;
  private samples: RabbitSampleView[] = [];
  private liveTimer: ReturnType<typeof setInterval> | undefined;
  private sampling = false;

  constructor(private readonly deps: RabbitObjectModelDeps) {
    this.current = this.empty();
  }

  get kind(): RabbitObjectKind {
    return this.deps.kind;
  }

  get vhost(): string {
    return this.deps.vhost;
  }

  get name(): string {
    return this.deps.name;
  }

  /** What the page renders. */
  state(): RabbitObjectState {
    return {
      ...this.current,
      count: this.count,
      messages: this.messages,
      peeked: this.peeked,
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      ...(this.liveTimer === undefined && this.samples.length === 0
        ? {}
        : { live: { on: this.liveTimer !== undefined, samples: this.samples } }),
    };
  }

  /** True while the live graphs read the queue every few seconds. */
  get live(): boolean {
    return this.liveTimer !== undefined;
  }

  /**
   * Starts the live graphs of a queue: one reading now and one every `intervalMs`, each handed
   * on through `onState`. A reading that fails stops the graphs and goes to `onError`. The
   * readings stay for the page after a stop, and a new start begins a new graph.
   */
  async startLive(
    onState: (state: RabbitObjectState) => void,
    onError: (error: unknown) => void,
    intervalMs = LIVE_INTERVAL_MS,
  ): Promise<void> {
    if (this.deps.kind !== 'queue') {
      throw new DbError('unsupported', msg('Only a queue has live graphs'));
    }
    this.stopLive();
    this.samples = [];
    const tick = async (): Promise<void> => {
      if (this.sampling) {
        return;
      }
      this.sampling = true;
      try {
        await this.sample();
        onState(this.state());
      } catch (error) {
        this.stopLive();
        onError(error);
      } finally {
        this.sampling = false;
      }
    };
    this.liveTimer = setInterval(() => {
      void tick();
    }, intervalMs);
    await tick();
  }

  /** Stops the live graphs; what they read stays on the page. */
  stopLive(): void {
    if (this.liveTimer !== undefined) {
      clearInterval(this.liveTimer);
      this.liveTimer = undefined;
    }
  }

  /** Reads the queue once for the graphs: the counts and the rates of the broker's statistics. */
  async sample(): Promise<void> {
    const queue = await (await this.deps.session()).getQueue(this.deps.vhost, this.deps.name);
    this.samples = [
      ...this.samples,
      {
        at: Date.now(),
        ready: queue.ready,
        unacked: queue.unacked,
        publish: queue.incomingRate ?? 0,
        deliver: queue.deliverRate ?? 0,
        ack: queue.ackRate ?? 0,
      },
    ].slice(-MAX_RABBIT_SAMPLES);
    this.current = {
      ...this.current,
      state: queue.state,
      ready: queue.ready,
      unacked: queue.unacked,
      total: queue.total,
      consumers: queue.consumers,
    };
  }

  /** Reads the figures and bindings again. */
  async refresh(): Promise<RabbitObjectState> {
    const session = await this.deps.session();
    const { kind, vhost, name } = this.deps;
    if (kind === 'vhost') {
      this.current = await this.readVhost(session);
      return this.state();
    }
    if (kind === 'cluster') {
      this.current = await this.readCluster(session);
      return this.state();
    }
    const bindings = await session.listBindings(
      vhost,
      kind === 'queue' ? { queue: name } : { exchange: name },
    );
    if (kind === 'queue') {
      const queue = await session.getQueue(vhost, name);
      this.current = {
        ...this.empty(),
        type: queue.type === '' ? 'classic' : queue.type,
        state: queue.state,
        ready: queue.ready,
        unacked: queue.unacked,
        total: queue.total,
        consumers: queue.consumers,
        facts: queueFacts(queue),
        arguments: factsOf(queue.arguments),
        bindings: this.bindingViews(bindings),
        bindingsCut: bindings.length > MAX_BINDINGS,
        consumersList: queue.consumerDetails.map((consumer) => ({
          tag: consumer.tag,
          connection: consumer.connectionName,
          channel: consumer.channel,
          user: consumer.user,
          prefetch: consumer.prefetch,
          ackRequired: consumer.ackRequired,
          exclusive: consumer.exclusive,
          active: consumer.active,
        })),
      };
    } else {
      const exchange = await session.getExchange(vhost, name);
      this.current = {
        ...this.empty(),
        type: exchange.type,
        facts: exchangeFacts(exchange),
        arguments: factsOf(exchange.arguments),
        bindings: this.bindingViews(bindings),
        bindingsCut: bindings.length > MAX_BINDINGS,
      };
    }
    this.bindingList = bindings.slice(0, MAX_BINDINGS);
    return this.state();
  }

  /** The figures of a virtual host page: each part is read alone, so one refusal hides only itself. */
  private async readVhost(
    session: RabbitSession,
  ): Promise<Omit<RabbitObjectState, 'messages' | 'peeked' | 'count' | 'notice'>> {
    const { vhost } = this.deps;
    const failed = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    const admin: { -readonly [K in keyof RabbitAdminView]: RabbitAdminView[K] } = {
      me: session.server.user,
      connections: [],
      connectionsTotal: 0,
      users: [],
      policies: [],
    };
    try {
      const page = await session.listConnections(vhost);
      admin.connections = page.items.map((connection) => ({
        name: connection.name,
        user: connection.user,
        state: connection.state,
        protocol: connection.protocol,
        peer: connection.peer,
        channels: connection.channels,
        connectedAt: timeText(connection.connectedAt),
        clientName: connection.clientName,
        product: connection.product,
        received: formatSize(connection.receivedBytes),
        sent: formatSize(connection.sentBytes),
      }));
      admin.connectionsTotal = page.total;
    } catch (error) {
      admin.connectionsError = failed(error);
    }
    try {
      const users = await session.listUsers();
      const permissions = new Map(
        (await session.listPermissions(vhost)).map((permission) => [permission.user, permission]),
      );
      admin.users = users.map((user) => {
        const permission = permissions.get(user.name);
        return {
          name: user.name,
          tags: [...user.tags],
          ...(permission === undefined
            ? {}
            : {
                permission: {
                  configure: permission.configure,
                  write: permission.write,
                  read: permission.read,
                },
              }),
        };
      });
    } catch (error) {
      admin.usersError = failed(error);
    }
    try {
      admin.policies = (await session.listPolicies(vhost)).map((policy) => ({
        name: policy.name,
        pattern: policy.pattern,
        applyTo: policy.applyTo,
        priority: policy.priority,
        definition: jsonText(policy.definition),
        ...(policy.operator === true ? { operator: true } : {}),
      }));
    } catch (error) {
      admin.policiesError = failed(error);
    }
    try {
      const limits = await session.listVhostLimits(vhost);
      admin.limits = {
        ...(limits.maxConnections === undefined ? {} : { maxConnections: limits.maxConnections }),
        ...(limits.maxQueues === undefined ? {} : { maxQueues: limits.maxQueues }),
      };
    } catch (error) {
      admin.limitsError = failed(error);
    }
    try {
      const settings = await session.readVhostSettings(vhost);
      admin.settings = {
        description: settings.description,
        tags: [...settings.tags],
        defaultQueueType: settings.defaultQueueType,
      };
    } catch (error) {
      admin.settingsError = failed(error);
    }
    this.bindingList = [];
    return {
      ...this.empty(),
      facts: [
        { key: msg('Virtual host'), value: vhost },
        { key: msg('Signed in as'), value: session.server.user },
        { key: msg('Broker version'), value: session.server.version },
      ],
      admin,
    };
  }

  /** The page of the whole broker: its totals, every node with its resources and its settings. */
  private async readCluster(
    session: RabbitSession,
  ): Promise<Omit<RabbitObjectState, 'messages' | 'peeked' | 'count' | 'notice'>> {
    const info = await session.readCluster();
    let parameters: RabbitFactView[] = [];
    let parametersError: string | undefined;
    try {
      parameters = (await session.listGlobalParameters()).map((parameter) => ({
        key: parameter.name,
        value: jsonText(parameter.value),
      }));
    } catch (error) {
      parametersError = error instanceof Error ? error.message : String(error);
    }
    this.bindingList = [];
    return {
      ...this.empty(),
      facts: [
        { key: msg('Cluster'), value: info.clusterName },
        { key: msg('Signed in as'), value: session.server.user },
        { key: msg('Broker version'), value: info.version },
        { key: msg('Erlang'), value: info.erlang },
      ],
      cluster: {
        clusterName: info.clusterName,
        version: info.version,
        erlang: info.erlang,
        node: info.node,
        queues: info.queues,
        exchanges: info.exchanges,
        connections: info.connections,
        channels: info.channels,
        consumers: info.consumers,
        ready: info.ready,
        unacked: info.unacked,
        listeners: info.listeners.map((listener) => ({ ...listener })),
        nodes: info.nodes.map((node) => ({
          name: node.name,
          type: node.type,
          running: node.running,
          uptime: node.running ? uptimeText(node.uptimeMs) : '',
          memUsed: node.memUsed,
          memLimit: node.memLimit,
          memAlarm: node.memAlarm,
          diskFree: node.diskFree,
          diskFreeLimit: node.diskFreeLimit,
          diskAlarm: node.diskAlarm,
          fdUsed: node.fdUsed,
          fdTotal: node.fdTotal,
          socketsUsed: node.socketsUsed,
          socketsTotal: node.socketsTotal,
          procUsed: node.procUsed,
          procTotal: node.procTotal,
          processors: node.processors,
          partitions: [...node.partitions],
          draining: node.draining,
        })),
        parameters,
        ...(parametersError === undefined ? {} : { parametersError }),
      },
    };
  }

  /**
   * Binds this queue or exchange to another. A queue is only ever the end of a binding; the
   * default exchange cannot be bound at all (the broker routes to a queue by its name).
   */
  async addBinding(params: RabbitBindingParams): Promise<RabbitObjectState> {
    this.requireWritable();
    const { kind, vhost, name } = this.deps;
    const peer = params.peer.trim();
    if (kind === 'vhost' || kind === 'cluster') {
      throw new DbError('unsupported', msg('A virtual host has no bindings of its own'));
    }
    if (peer === '' || DEFAULT_EXCHANGE_NAMES.has(peer)) {
      throw new DbError('syntax', msg('Name the exchange or queue to bind to'));
    }
    if (kind === 'queue' && params.direction !== 'fromExchange') {
      throw new DbError('unsupported', msg('A queue can only receive from an exchange'));
    }
    if (DEFAULT_EXCHANGE_NAMES.has(name) && params.direction !== 'fromExchange') {
      throw new DbError('unsupported', msg('The default exchange cannot be bound'));
    }
    const args = parseJsonObject(params.arguments, msg('The arguments'));
    const request: RabbitBindingRequest =
      params.direction === 'fromExchange'
        ? {
            source: peer,
            destination: name,
            destinationType: kind === 'queue' ? 'queue' : 'exchange',
            routingKey: params.routingKey,
            arguments: args,
          }
        : {
            source: name,
            destination: peer,
            destinationType: params.direction === 'toQueue' ? 'queue' : 'exchange',
            routingKey: params.routingKey,
            arguments: args,
          };
    await (await this.deps.session()).bind(vhost, request);
    await this.refresh();
    return this.state();
  }

  /** The binding listed at `index`, for the question before it goes. */
  bindingAt(index: number): RabbitBinding | undefined {
    return this.bindingList[index];
  }

  async removeBinding(index: number): Promise<RabbitObjectState> {
    this.requireWritable();
    const binding = this.bindingList[index];
    if (binding === undefined) {
      throw new DbError('not-found', msg('The binding is no longer listed: read the page again'));
    }
    if (binding.source === '') {
      throw new DbError(
        'unsupported',
        msg('The binding of the default exchange belongs to the queue and cannot be removed'),
      );
    }
    await (await this.deps.session()).unbind(this.deps.vhost, binding);
    await this.refresh();
    return this.state();
  }

  async closeConnection(name: string): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    await (await this.deps.session()).closeConnection(name);
    await this.refresh();
    // The broker refreshes its list of connections every few seconds, so a connection it has
    // just closed may still be listed; it is gone, and the page says so.
    const admin = this.current.admin;
    if (admin !== undefined) {
      const connections = admin.connections.filter((connection) => connection.name !== name);
      this.current = {
        ...this.current,
        admin: {
          ...admin,
          connections,
          connectionsTotal: Math.max(
            0,
            admin.connectionsTotal - (admin.connections.length - connections.length),
          ),
        },
      };
    }
    return this.state();
  }

  async createUser(
    name: string,
    password: string,
    tags: readonly string[],
  ): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    if (name.trim() === '') {
      throw new DbError('syntax', msg('A user needs a name'));
    }
    if (password === '') {
      throw new DbError('syntax', msg('A user needs a password'));
    }
    const clean = tags.map((tag) => tag.trim()).filter((tag) => tag !== '');
    await (await this.deps.session()).createUser({ name: name.trim(), password, tags: clean });
    await this.refresh();
    return this.state();
  }

  /**
   * Changes a user's password, tags or both. The broker forgets the password when a PUT leaves
   * it out, so the session sends the stored hash back with new tags (D162).
   */
  async updateUser(
    name: string,
    change: {
      readonly password?: string | undefined;
      readonly tags?: readonly string[] | undefined;
    },
  ): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    const password = change.password === '' ? undefined : change.password;
    const tags = change.tags?.map((tag) => tag.trim()).filter((tag) => tag !== '');
    if (password === undefined && tags === undefined) {
      throw new DbError('syntax', msg('Give a new password or new tags'));
    }
    await (
      await this.deps.session()
    ).updateUser(name, {
      ...(password === undefined ? {} : { password }),
      ...(tags === undefined ? {} : { tags }),
    });
    await this.refresh();
    return this.state();
  }

  async deleteUser(name: string): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    const session = await this.deps.session();
    if (name === session.server.user) {
      throw new DbError(
        'unsupported',
        msg('The user this connection signs in as cannot be deleted'),
      );
    }
    await session.deleteUser(name);
    await this.refresh();
    return this.state();
  }

  async setPermission(
    user: string,
    permission: { readonly configure: string; readonly write: string; readonly read: string },
  ): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    for (const pattern of [permission.configure, permission.write, permission.read]) {
      const problem = patternProblem(pattern);
      if (problem !== undefined) {
        throw new DbError('syntax', problem);
      }
    }
    await (await this.deps.session()).setPermission(this.deps.vhost, { user, ...permission });
    await this.refresh();
    return this.state();
  }

  async clearPermission(user: string): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    await (await this.deps.session()).clearPermission(this.deps.vhost, user);
    await this.refresh();
    return this.state();
  }

  /**
   * Sets one limit of the virtual host (the most connections or queues it may hold), or lifts
   * it when `value` is left out. The broker treats a negative figure as "no limit", so lifting
   * deletes the limit instead.
   */
  async setLimit(limit: VhostLimitName, value: number | undefined): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    if (!RABBIT_VHOST_LIMITS.includes(limit)) {
      throw new DbError('syntax', msg('A virtual host limits its connections or its queues'));
    }
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new DbError('syntax', msg('A limit is a whole number, 0 or more'));
    }
    const session = await this.deps.session();
    if (value === undefined) {
      await session.clearVhostLimit(this.deps.vhost, limit);
    } else {
      await session.setVhostLimit(this.deps.vhost, limit, value);
    }
    await this.refresh();
    return this.state();
  }

  /** Changes the description, tags and default queue type of the virtual host (V13.39). */
  async setVhostSettings(params: {
    readonly description: string;
    readonly tags: readonly string[];
    readonly defaultQueueType: string;
  }): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    const tags = params.tags.map((tag) => tag.trim()).filter((tag) => tag !== '');
    if (tags.some((tag) => /[,\s]/u.test(tag))) {
      throw new DbError('syntax', msg('A tag is one word, without commas or spaces'));
    }
    if (!(RABBIT_QUEUE_TYPES as readonly string[]).includes(params.defaultQueueType)) {
      throw new DbError('syntax', msg('The default queue type is classic, quorum or stream'));
    }
    await (
      await this.deps.session()
    ).setVhostSettings(this.deps.vhost, {
      description: params.description.trim(),
      tags: [...new Set(tags)],
      defaultQueueType: params.defaultQueueType,
    });
    await this.refresh();
    return this.state();
  }

  async setPolicy(params: RabbitPolicyParams): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    const name = params.name.trim();
    if (name === '') {
      throw new DbError('syntax', msg('A policy needs a name'));
    }
    if (params.pattern === '') {
      throw new DbError('syntax', msg('A policy needs a pattern of the names it applies to'));
    }
    const problem = patternProblem(params.pattern);
    if (problem !== undefined) {
      throw new DbError('syntax', problem);
    }
    if (!POLICY_TARGETS.includes(params.applyTo)) {
      throw new DbError('syntax', msg('A policy applies to queues, exchanges or all'));
    }
    const definition = parseJsonObject(params.definition, msg('The definition'));
    if (Object.keys(definition).length === 0) {
      throw new DbError('syntax', msg('A policy needs a definition, such as {"max-length": 1000}'));
    }
    await (
      await this.deps.session()
    ).setPolicy({
      vhost: this.deps.vhost,
      name,
      pattern: params.pattern,
      applyTo: params.applyTo,
      priority: params.priority,
      definition,
      ...(params.operator === true ? { operator: true } : {}),
    });
    await this.refresh();
    return this.state();
  }

  async deletePolicy(name: string, operator = false): Promise<RabbitObjectState> {
    this.requireWritable();
    this.requireVhostPage();
    await (await this.deps.session()).deletePolicy(this.deps.vhost, name, operator);
    await this.refresh();
    return this.state();
  }

  /**
   * Looks at the first messages of the queue. The broker fetches and puts them back, so
   * the queue keeps them; the broker marks them redelivered, and a message put back may
   * change its place (D156).
   */
  async peek(count: number, signal?: AbortSignal): Promise<RabbitObjectState> {
    if (this.deps.kind !== 'queue') {
      throw new DbError('unsupported', msg('An exchange holds no messages to look at'));
    }
    const session = await this.deps.session();
    const wanted = Math.min(Math.max(1, Math.trunc(count)), MAX_RABBIT_PEEK);
    const messages = await session.peekMessages({
      vhost: this.deps.vhost,
      queue: this.deps.name,
      count: wanted,
      maxBytes: MAX_SHOWN_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    this.messages = messages.map(messageViewOf);
    this.count = wanted;
    this.peeked = true;
    this.notice =
      messages.length === 0
        ? msg('The queue holds no messages')
        : messages.length < wanted
          ? msg('Only {0} messages were there to look at', messages.length)
          : undefined;
    // The figures changed with the look (the messages are unacknowledged for a moment).
    await this.refresh();
    return this.state();
  }

  /** Publishes one message; returns whether a queue took it. */
  async publish(params: RabbitPublishParams): Promise<{
    readonly state: RabbitObjectState;
    readonly routed: boolean;
  }> {
    this.requireWritable();
    if (this.deps.kind === 'vhost' || this.deps.kind === 'cluster') {
      throw new DbError('unsupported', msg('Messages are published from a queue or an exchange'));
    }
    const session = await this.deps.session();
    const payload = redisValueBytes(params.payload);
    if (payload === undefined) {
      throw new DbError('syntax', msg('The hexadecimal text is not valid'));
    }
    const headers: Record<string, string> = {};
    for (const header of params.headers) {
      if (header.name.trim() !== '') {
        headers[header.name.trim()] = header.value;
      }
    }
    const properties: Record<string, unknown> = {
      delivery_mode: params.persistent ? 2 : 1,
      ...(params.contentType === undefined || params.contentType.trim() === ''
        ? {}
        : { content_type: params.contentType.trim() }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
    // A queue is reached through the default exchange, by its own name.
    const toQueue = this.deps.kind === 'queue';
    const routed = await session.publish({
      vhost: this.deps.vhost,
      exchange: toQueue ? '' : this.deps.name,
      routingKey: toQueue ? this.deps.name : params.routingKey,
      payload,
      properties,
    });
    await this.refresh();
    return { state: this.state(), routed };
  }

  async purge(): Promise<void> {
    this.requireWritable();
    if (this.deps.kind !== 'queue') {
      throw new DbError('unsupported', msg('An exchange holds no messages to remove'));
    }
    await (await this.deps.session()).purgeQueue(this.deps.vhost, this.deps.name);
    this.messages = [];
    this.peeked = false;
    this.notice = undefined;
    await this.refresh();
  }

  async deleteObject(): Promise<void> {
    this.requireWritable();
    if (this.deps.kind === 'vhost' || this.deps.kind === 'cluster') {
      throw new DbError('unsupported', msg('A virtual host is not deleted from here'));
    }
    const session = await this.deps.session();
    if (this.deps.kind === 'queue') {
      await session.deleteQueue(this.deps.vhost, this.deps.name);
    } else {
      if (this.deps.name === '' || this.deps.name.startsWith('amq.')) {
        throw new DbError('unsupported', msg('The broker’s own exchanges cannot be deleted'));
      }
      await session.deleteExchange(this.deps.vhost, this.deps.name);
    }
  }

  private bindingViews(
    bindings: readonly {
      readonly source: string;
      readonly destination: string;
      readonly destinationType: 'queue' | 'exchange';
      readonly routingKey: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }[],
  ): RabbitObjectState['bindings'] {
    return bindings.slice(0, MAX_BINDINGS).map((binding) => ({
      source: binding.source,
      destination: binding.destination,
      destinationType: binding.destinationType,
      routingKey: binding.routingKey,
      arguments: Object.keys(binding.arguments).length === 0 ? '' : jsonText(binding.arguments),
    }));
  }

  private empty(): Omit<RabbitObjectState, 'messages' | 'peeked' | 'count' | 'notice'> {
    return {
      kind: this.deps.kind,
      vhost: this.deps.vhost,
      name: this.deps.name,
      connectionName: this.deps.connectionName,
      readOnly: this.deps.readOnly,
      type: '',
      state: '',
      ready: 0,
      unacked: 0,
      total: 0,
      consumers: 0,
      facts: [],
      arguments: [],
      bindings: [],
      bindingsCut: false,
      consumersList: [],
    };
  }

  private requireVhostPage(): void {
    if (this.deps.kind !== 'vhost') {
      throw new DbError('unsupported', msg('This belongs on the page of a virtual host'));
    }
  }

  private requireWritable(): void {
    if (this.deps.readOnly) {
      throw new DbError(
        'permission-denied',
        msg('The connection is read-only: nothing may change'),
      );
    }
  }
}

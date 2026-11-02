// What the RabbitMQ queue and exchange page (V13.26) shows and does, free of `vscode`: it
// reads the figures and bindings of one queue or exchange, peeks at the first messages of
// a queue and publishes a message. A peek never takes a message from its queue: the
// session fetches and puts back (D156), and a queue it does not know is an error, not an
// empty list.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type {
  RabbitExchangeInfo,
  RabbitMessage,
  RabbitQueueInfo,
  RabbitSession,
} from '../../drivers/rabbitmq-driver';
import { formatSize } from '../../shared/byte-size';
import {
  DEFAULT_RABBIT_PEEK,
  MAX_RABBIT_PEEK,
  type RabbitFactView,
  type RabbitMessageView,
  type RabbitObjectKind,
  type RabbitObjectState,
} from '../../shared/protocols/rabbitmq-object';
import { redisValueBytes, type RedisValue, redisValueOf } from '../../shared/redis-value';

/** Bytes of one payload the page shows; the rest is cut and says so. */
export const MAX_SHOWN_BYTES = 256 * 1024;

/** Bytes a peek brings at most, all messages together. */
export const MAX_PEEK_BYTES = 8 * 1024 * 1024;

/** Bindings the page lists; more are counted. */
export const MAX_BINDINGS = 500;

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
  private messages: RabbitMessageView[] = [];
  private count = DEFAULT_RABBIT_PEEK;
  private peeked = false;
  private notice: string | undefined;

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
    };
  }

  /** Reads the figures and bindings again. */
  async refresh(): Promise<RabbitObjectState> {
    const session = await this.deps.session();
    const { kind, vhost, name } = this.deps;
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
    };
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

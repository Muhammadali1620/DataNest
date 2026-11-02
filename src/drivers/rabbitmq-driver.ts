// What a RabbitMQ driver offers (V13.26): the few calls the browser needs, in plain values.
// Not a SQL driver (D81). It speaks the management plugin's HTTP API, not AMQP, so it can
// look at queues and exchanges, peek at messages and publish, but it never consumes a
// message: a peek puts every message back (D156).

import type { ResolvedConnectionConfig } from '../shared/connection';

/** What the broker said about itself when the session opened. */
export interface RabbitServerInfo {
  /** `3.13.7`. */
  readonly version: string;
  /** The name of the cluster. */
  readonly clusterName: string;
  /** The user the management API signed in as. */
  readonly user: string;
}

export interface RabbitVhostInfo {
  readonly name: string;
  readonly messages: number;
}

/** A queue as the management API lists it. */
export interface RabbitQueueInfo {
  readonly vhost: string;
  readonly name: string;
  /** `classic`, `quorum`, `stream`; empty when the broker does not say. */
  readonly type: string;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly exclusive: boolean;
  /** `running`, `idle`, `flow`, `down`, … */
  readonly state: string;
  readonly ready: number;
  readonly unacked: number;
  readonly total: number;
  readonly consumers: number;
  /** Bytes of memory the queue uses; 0 when unknown. */
  readonly memory: number;
  readonly policy: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Messages per second published to the queue, when the broker says. */
  readonly incomingRate: number | undefined;
  readonly node: string;
}

export interface RabbitExchangeInfo {
  readonly vhost: string;
  /** Empty for the default exchange. */
  readonly name: string;
  readonly type: string;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly internal: boolean;
  readonly policy: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface RabbitBinding {
  readonly source: string;
  readonly destination: string;
  readonly destinationType: 'queue' | 'exchange';
  readonly routingKey: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** A list the broker may have cut: `total` is how many there are. */
export interface RabbitPage<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface RabbitMessage {
  /** The payload, cut at `maxBytes` of the request. */
  readonly payload: Uint8Array;
  /** Bytes the whole payload has. */
  readonly payloadBytes: number;
  /** True when the broker had already delivered the message once (a peek sets it). */
  readonly redelivered: boolean;
  readonly exchange: string;
  readonly routingKey: string;
  /** Messages still waiting in the queue after this one was looked at. */
  readonly messagesLeft: number;
  /** The properties the publisher set (content type, headers, priority, …), as sent. */
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface RabbitPeekRequest {
  readonly vhost: string;
  readonly queue: string;
  readonly count: number;
  /** A payload longer than this is cut; its full length stays in `payloadBytes`. */
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface RabbitPublishRequest {
  readonly vhost: string;
  /** Empty: the default exchange, which routes to the queue named like the routing key. */
  readonly exchange: string;
  readonly routingKey: string;
  readonly payload: Uint8Array;
  /** Properties: `content_type`, `delivery_mode`, `priority`, `headers`, … */
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface RabbitQueueDeclaration {
  readonly vhost: string;
  readonly name: string;
  readonly type?: 'classic' | 'quorum' | 'stream';
  readonly durable: boolean;
  readonly autoDelete: boolean;
}

export interface RabbitExchangeDeclaration {
  readonly vhost: string;
  readonly name: string;
  readonly type: 'direct' | 'fanout' | 'topic' | 'headers';
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly internal: boolean;
}

/** One live connection to the management API. */
export interface RabbitSession {
  readonly server: RabbitServerInfo;
  listVhosts(): Promise<readonly RabbitVhostInfo[]>;
  listQueues(vhost: string): Promise<RabbitPage<RabbitQueueInfo>>;
  listExchanges(vhost: string): Promise<RabbitPage<RabbitExchangeInfo>>;
  getQueue(vhost: string, name: string): Promise<RabbitQueueInfo>;
  getExchange(vhost: string, name: string): Promise<RabbitExchangeInfo>;
  /** Bindings that end in the queue (`queue`) or start from or end in the exchange. */
  listBindings(
    vhost: string,
    target: { readonly queue: string } | { readonly exchange: string },
  ): Promise<readonly RabbitBinding[]>;
  /**
   * Looks at the first messages of a queue without taking them: each is fetched and
   * put back at once (`ack_requeue_true`). The broker marks them redelivered, and a
   * message put back may change its place among the others (D156).
   */
  peekMessages(request: RabbitPeekRequest): Promise<readonly RabbitMessage[]>;
  /** Publishes one message; false when no queue was bound to take it. */
  publish(request: RabbitPublishRequest): Promise<boolean>;
  declareQueue(declaration: RabbitQueueDeclaration): Promise<void>;
  deleteQueue(vhost: string, name: string): Promise<void>;
  purgeQueue(vhost: string, name: string): Promise<void>;
  declareExchange(declaration: RabbitExchangeDeclaration): Promise<void>;
  deleteExchange(vhost: string, name: string): Promise<void>;
  close(): Promise<void>;
}

export interface RabbitDriver {
  readonly id: 'rabbitmq';
  openSession(config: ResolvedConnectionConfig): Promise<RabbitSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/rabbitmq.js. */
export interface RabbitDriverModule {
  readonly driver: RabbitDriver;
}

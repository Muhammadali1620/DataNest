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

/** One consumer of a queue, as the queue's own record lists it. */
export interface RabbitConsumerInfo {
  readonly tag: string;
  /** The connection it came in by (`127.0.0.1:5000 -> 127.0.0.1:5672` or the client's name). */
  readonly connectionName: string;
  /** The channel's name, `<connection> (1)`. */
  readonly channel: string;
  readonly user: string;
  /** Messages the broker sends before it waits for acknowledgements; 0 for no limit. */
  readonly prefetch: number;
  readonly ackRequired: boolean;
  readonly exclusive: boolean;
  readonly active: boolean;
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
  /** Messages per second delivered to consumers and acknowledged, when the broker says (V13.32). */
  readonly deliverRate?: number | undefined;
  readonly ackRate?: number | undefined;
  readonly node: string;
  /** Who consumes the queue; only a single queue's record has it, so a listing leaves it empty. */
  readonly consumerDetails: readonly RabbitConsumerInfo[];
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
  /** The broker's own name for this binding, which is what removing it needs. */
  readonly propertiesKey: string;
}

/** A binding to make. */
export interface RabbitBindingRequest {
  /** An exchange; the default exchange cannot be bound. */
  readonly source: string;
  readonly destination: string;
  readonly destinationType: 'queue' | 'exchange';
  readonly routingKey: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

/** A connection a client has open to the broker. */
export interface RabbitConnectionInfo {
  /** The broker's name for it; closing it needs this. */
  readonly name: string;
  readonly user: string;
  readonly vhost: string;
  /** `running`, `blocked`, `blocking`, … */
  readonly state: string;
  readonly protocol: string;
  /** `host:port` of the client. */
  readonly peer: string;
  readonly channels: number;
  /** Milliseconds since the epoch; undefined when the broker does not say. */
  readonly connectedAt: number | undefined;
  readonly receivedBytes: number;
  readonly sentBytes: number;
  /** The name the client gave its connection, and the library it uses. */
  readonly clientName: string;
  readonly product: string;
}

export interface RabbitUserInfo {
  readonly name: string;
  readonly tags: readonly string[];
}

/** What a user may do in a virtual host: three patterns (regular expressions) of names. */
export interface RabbitPermissionInfo {
  readonly user: string;
  readonly configure: string;
  readonly write: string;
  readonly read: string;
}

export interface RabbitPolicyInfo {
  readonly name: string;
  readonly pattern: string;
  /** `queues`, `exchanges`, `all`, `classic_queues`, `quorum_queues`, `streams`. */
  readonly applyTo: string;
  readonly priority: number;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface RabbitPolicyDeclaration extends RabbitPolicyInfo {
  readonly vhost: string;
}

/** One node of the cluster, with its resources (V13.35). Figures the broker leaves out are 0. */
export interface RabbitNodeInfo {
  readonly name: string;
  /** `disc` or `ram`. */
  readonly type: string;
  readonly running: boolean;
  readonly uptimeMs: number;
  readonly memUsed: number;
  readonly memLimit: number;
  /** True while the node holds back publishers because it is short of memory. */
  readonly memAlarm: boolean;
  readonly diskFree: number;
  readonly diskFreeLimit: number;
  readonly diskAlarm: boolean;
  readonly fdUsed: number;
  readonly fdTotal: number;
  readonly socketsUsed: number;
  readonly socketsTotal: number;
  readonly procUsed: number;
  readonly procTotal: number;
  readonly processors: number;
  /** Nodes this one lost sight of: a split of the cluster. */
  readonly partitions: readonly string[];
  /** The node is being drained: it takes no new work. */
  readonly draining: boolean;
}

export interface RabbitListener {
  readonly protocol: string;
  readonly ip: string;
  readonly port: number;
  readonly node: string;
}

/** The whole broker: its version, totals and nodes (V13.35). */
export interface RabbitClusterInfo {
  readonly clusterName: string;
  readonly version: string;
  readonly erlang: string;
  /** The node that answered. */
  readonly node: string;
  readonly queues: number;
  readonly exchanges: number;
  readonly connections: number;
  readonly channels: number;
  readonly consumers: number;
  readonly ready: number;
  readonly unacked: number;
  readonly listeners: readonly RabbitListener[];
  readonly nodes: readonly RabbitNodeInfo[];
}

/** A global parameter: a setting of the broker as a whole (V13.35). */
export interface RabbitGlobalParameter {
  readonly name: string;
  readonly value: unknown;
}

/** The limits of a virtual host the extension sets. */
export type VhostLimitName = 'max-connections' | 'max-queues';

/** The limits of a virtual host that are set; one left out has none. */
export interface RabbitVhostLimits {
  readonly maxConnections?: number;
  readonly maxQueues?: number;
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
  /** Makes a virtual host; one that exists is left as it is. */
  createVhost(name: string): Promise<void>;
  /** Deletes a virtual host with every queue, exchange and message in it. */
  deleteVhost(name: string): Promise<void>;
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
  /** Binds a queue or an exchange to an exchange; an existing equal binding is left as it is. */
  bind(vhost: string, binding: RabbitBindingRequest): Promise<void>;
  /** Removes one binding, as `listBindings` named it. */
  unbind(vhost: string, binding: RabbitBinding): Promise<void>;
  /** The connections that use a virtual host (the first page; `total` counts them all). */
  listConnections(vhost: string): Promise<RabbitPage<RabbitConnectionInfo>>;
  /** Closes a connection by the name `listConnections` gave; its client sees it drop. */
  closeConnection(name: string): Promise<void>;
  /** Every user of the broker. Needs the administrator tag. */
  listUsers(): Promise<readonly RabbitUserInfo[]>;
  createUser(user: {
    readonly name: string;
    readonly password: string;
    readonly tags: readonly string[];
  }): Promise<void>;
  /** Changes the password, the tags or both of a user; what is left out stays as it is. */
  updateUser(
    name: string,
    change: { readonly password?: string; readonly tags?: readonly string[] },
  ): Promise<void>;
  deleteUser(name: string): Promise<void>;
  /** The permissions of a virtual host. Needs the administrator tag. */
  listPermissions(vhost: string): Promise<readonly RabbitPermissionInfo[]>;
  setPermission(vhost: string, permission: RabbitPermissionInfo): Promise<void>;
  clearPermission(vhost: string, user: string): Promise<void>;
  listPolicies(vhost: string): Promise<readonly RabbitPolicyInfo[]>;
  setPolicy(policy: RabbitPolicyDeclaration): Promise<void>;
  deletePolicy(vhost: string, name: string): Promise<void>;
  /** The broker's version, totals, listeners and every node with its resources (V13.35). */
  readCluster(): Promise<RabbitClusterInfo>;
  /** The settings of the broker as a whole. Needs the administrator tag. */
  listGlobalParameters(): Promise<readonly RabbitGlobalParameter[]>;
  /** The limits set on a virtual host. */
  listVhostLimits(vhost: string): Promise<RabbitVhostLimits>;
  /** Sets one limit of a virtual host; a negative value means no limit to the broker, so use `clearVhostLimit`. */
  setVhostLimit(vhost: string, name: VhostLimitName, value: number): Promise<void>;
  clearVhostLimit(vhost: string, name: VhostLimitName): Promise<void>;
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

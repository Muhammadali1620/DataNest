// The RabbitMQ queue, exchange and virtual host page (V13.26, V13.28): one panel per queue or
// exchange shows its figures, arguments, bindings and consumers, peeks at the first messages
// of a queue and publishes a message; the page of a virtual host lists its connections, users
// with their permissions, policies and limits; the page of the cluster shows the nodes. A peek puts every message back (D156). The host runs every command and asks
// before writing to production; a read-only connection is refused there.

import { defineProtocol } from '../rpc';
import { array, boolean, literal, number, object, optional, string } from '../schema';
import type { Infer } from '../schema';
import { redisValueSchema } from './redis-key';

export const RABBIT_OBJECT_KINDS = ['queue', 'exchange', 'vhost', 'cluster'] as const;
export type RabbitObjectKind = (typeof RABBIT_OBJECT_KINDS)[number];

/** The most messages one peek brings. */
export const MAX_RABBIT_PEEK = 100;
export const DEFAULT_RABBIT_PEEK = 10;

/** A line of the figures or arguments the page lists: a name and its value as text. */
export const rabbitFactSchema = object({
  key: string({ maxLength: 1000 }),
  value: string({ maxLength: 100_000 }),
});

export const rabbitBindingSchema = object({
  source: string({ maxLength: 1000 }),
  destination: string({ maxLength: 1000 }),
  destinationType: literal('queue', 'exchange'),
  routingKey: string({ maxLength: 100_000 }),
  arguments: string({ maxLength: 100_000 }),
});

/** Where a new binding goes, seen from the page that makes it. */
export const RABBIT_BINDING_DIRECTIONS = ['toQueue', 'toExchange', 'fromExchange'] as const;
export type RabbitBindingDirection = (typeof RABBIT_BINDING_DIRECTIONS)[number];

/** What a policy applies to. */
export const RABBIT_POLICY_TARGETS = [
  'all',
  'queues',
  'classic_queues',
  'quorum_queues',
  'streams',
  'exchanges',
] as const;

export const rabbitConsumerSchema = object({
  tag: string({ maxLength: 1000 }),
  connection: string({ maxLength: 1000 }),
  channel: string({ maxLength: 1000 }),
  user: string({ maxLength: 1000 }),
  prefetch: number({ integer: true, min: 0 }),
  ackRequired: boolean(),
  exclusive: boolean(),
  active: boolean(),
});

export const rabbitConnectionSchema = object({
  name: string({ maxLength: 1000 }),
  user: string({ maxLength: 1000 }),
  state: string({ maxLength: 100 }),
  protocol: string({ maxLength: 100 }),
  peer: string({ maxLength: 1000 }),
  channels: number({ integer: true, min: 0 }),
  /** When it connected, as text in the user's locale; empty when unknown. */
  connectedAt: string({ maxLength: 100 }),
  clientName: string({ maxLength: 1000 }),
  product: string({ maxLength: 1000 }),
  received: string({ maxLength: 100 }),
  sent: string({ maxLength: 100 }),
});

/** A user, with what the user may do in this page's virtual host (absent: nothing). */
export const rabbitUserSchema = object({
  name: string({ maxLength: 1000 }),
  tags: array(string({ maxLength: 100 }), { maxLength: 50 }),
  permission: optional(
    object({
      configure: string({ maxLength: 10_000 }),
      write: string({ maxLength: 10_000 }),
      read: string({ maxLength: 10_000 }),
    }),
  ),
});

export const rabbitPolicySchema = object({
  name: string({ maxLength: 1000 }),
  pattern: string({ maxLength: 10_000 }),
  applyTo: string({ maxLength: 100 }),
  priority: number({ integer: true }),
  /** The definition as indented JSON. */
  definition: string({ maxLength: 1_000_000 }),
  /** An operator policy (V13.39); left out for an ordinary one. */
  operator: optional(boolean()),
});

/** The default queue types a virtual host may name; empty leaves it to the broker (V13.39). */
export const RABBIT_QUEUE_TYPES = ['', 'classic', 'quorum', 'stream'] as const;

/** The limits set on a virtual host; one that is left out has none (V13.35). */
export const RABBIT_VHOST_LIMITS = ['max-connections', 'max-queues'] as const;

export const rabbitNodeSchema = object({
  name: string({ maxLength: 1000 }),
  /** `disc` or `ram`. */
  type: string({ maxLength: 100 }),
  running: boolean(),
  /** How long it has been up, in words (`3 d 4 h`); empty when it is not running. */
  uptime: string({ maxLength: 100 }),
  memUsed: number({ min: 0 }),
  memLimit: number({ min: 0 }),
  memAlarm: boolean(),
  diskFree: number({ min: 0 }),
  diskFreeLimit: number({ min: 0 }),
  diskAlarm: boolean(),
  fdUsed: number({ min: 0 }),
  fdTotal: number({ min: 0 }),
  socketsUsed: number({ min: 0 }),
  socketsTotal: number({ min: 0 }),
  procUsed: number({ min: 0 }),
  procTotal: number({ min: 0 }),
  processors: number({ integer: true, min: 0 }),
  /** Nodes this one lost sight of. */
  partitions: array(string({ maxLength: 1000 }), { maxLength: 100 }),
  draining: boolean(),
});

export const rabbitListenerSchema = object({
  protocol: string({ maxLength: 100 }),
  ip: string({ maxLength: 1000 }),
  port: number({ integer: true, min: 0 }),
  node: string({ maxLength: 1000 }),
});

/** The page of the whole broker (V13.35): totals, nodes with their resources, settings. */
export const rabbitClusterSchema = object({
  clusterName: string({ maxLength: 1000 }),
  version: string({ maxLength: 100 }),
  erlang: string({ maxLength: 100 }),
  /** The node the page is talking to. */
  node: string({ maxLength: 1000 }),
  queues: number({ integer: true, min: 0 }),
  exchanges: number({ integer: true, min: 0 }),
  connections: number({ integer: true, min: 0 }),
  channels: number({ integer: true, min: 0 }),
  consumers: number({ integer: true, min: 0 }),
  ready: number({ integer: true, min: 0 }),
  unacked: number({ integer: true, min: 0 }),
  listeners: array(rabbitListenerSchema, { maxLength: 200 }),
  nodes: array(rabbitNodeSchema, { maxLength: 100 }),
  /** The broker's global parameters, the value as indented JSON. */
  parameters: array(rabbitFactSchema, { maxLength: 200 }),
  parametersError: optional(string({ maxLength: 10_000 })),
});

export const rabbitAdminSchema = object({
  /** The user the page is signed in as; it may not delete itself. */
  me: string({ maxLength: 1000 }),
  connections: array(rabbitConnectionSchema, { maxLength: 500 }),
  /** How many connections there are; more than listed when the broker has many. */
  connectionsTotal: number({ integer: true, min: 0 }),
  connectionsError: optional(string({ maxLength: 10_000 })),
  users: array(rabbitUserSchema, { maxLength: 1000 }),
  usersError: optional(string({ maxLength: 10_000 })),
  policies: array(rabbitPolicySchema, { maxLength: 500 }),
  policiesError: optional(string({ maxLength: 10_000 })),
  /** The limits set on the virtual host (V13.35). */
  limits: optional(
    object({
      maxConnections: optional(number({ integer: true, min: 0 })),
      maxQueues: optional(number({ integer: true, min: 0 })),
    }),
  ),
  limitsError: optional(string({ maxLength: 10_000 })),
  /** The description, tags and default queue type of the virtual host (V13.39). */
  settings: optional(
    object({
      description: string({ maxLength: 10_000 }),
      tags: array(string({ maxLength: 1000 }), { maxLength: 100 }),
      defaultQueueType: string({ maxLength: 100 }),
    }),
  ),
  settingsError: optional(string({ maxLength: 10_000 })),
});

/** One reading of a queue for the live graphs: the counts and the broker's rates per second. */
export const rabbitSampleSchema = object({
  /** Milliseconds since 1970 when the reading was taken. */
  at: number({ integer: true, min: 0 }),
  ready: number({ integer: true, min: 0 }),
  unacked: number({ integer: true, min: 0 }),
  publish: number({ min: 0 }),
  deliver: number({ min: 0 }),
  ack: number({ min: 0 }),
});

/** The most readings the page keeps for its graphs. */
export const MAX_RABBIT_SAMPLES = 120;

export const rabbitMessageSchema = object({
  payload: redisValueSchema,
  payloadBytes: number({ integer: true, min: 0 }),
  redelivered: boolean(),
  exchange: string({ maxLength: 1000 }),
  routingKey: string({ maxLength: 100_000 }),
  messagesLeft: number({ integer: true, min: 0 }),
  /** The properties the publisher set, as indented JSON. */
  properties: string({ maxLength: 1_000_000 }),
});

export const rabbitObjectStateSchema = object({
  kind: literal(...RABBIT_OBJECT_KINDS),
  vhost: string({ maxLength: 1000 }),
  /** Empty for the default exchange. */
  name: string({ maxLength: 1000 }),
  connectionName: string({ maxLength: 500 }),
  readOnly: boolean(),
  /** `classic`, `topic`, … */
  type: string({ maxLength: 100 }),
  /** `running`, `idle`, … (queues). */
  state: string({ maxLength: 100 }),
  ready: number({ integer: true, min: 0 }),
  unacked: number({ integer: true, min: 0 }),
  total: number({ integer: true, min: 0 }),
  consumers: number({ integer: true, min: 0 }),
  facts: array(rabbitFactSchema, { maxLength: 200 }),
  arguments: array(rabbitFactSchema, { maxLength: 500 }),
  bindings: array(rabbitBindingSchema, { maxLength: 500 }),
  /** True when more bindings exist than the page lists. */
  bindingsCut: boolean(),
  /** Who consumes the queue (queues only). */
  consumersList: array(rabbitConsumerSchema, { maxLength: 200 }),
  /** Connections, users and policies (virtual host pages only). */
  admin: optional(rabbitAdminSchema),
  /** The broker as a whole (the cluster page only). */
  cluster: optional(rabbitClusterSchema),
  /** The live graphs of a queue: on while the host reads the queue every few seconds. */
  live: optional(
    object({
      on: boolean(),
      samples: array(rabbitSampleSchema, { maxLength: MAX_RABBIT_SAMPLES }),
    }),
  ),
  /** What the last peek asked for, so the page shows it again. */
  count: number({ integer: true, min: 1, max: MAX_RABBIT_PEEK }),
  messages: array(rabbitMessageSchema, { maxLength: MAX_RABBIT_PEEK }),
  /** True once a peek has run. */
  peeked: boolean(),
  /** What the last peek did not bring, in words (an empty queue, …). */
  notice: optional(string({ maxLength: 1000 })),
});

export const rabbitObjectProtocol = defineProtocol({
  host: {
    requests: {
      /** Reads the figures and bindings again; the peeked messages stay. */
      refresh: { params: object({}), result: object({}) },
      /** Looks at the first `count` messages of the queue; each is put back. */
      peek: {
        params: object({ count: number({ integer: true, min: 1, max: MAX_RABBIT_PEEK }) }),
        result: object({}),
      },
      /**
       * Publishes one message. A queue page publishes through the default exchange to
       * its own queue and ignores `routingKey`; an exchange page uses it.
       */
      publish: {
        params: object({
          routingKey: string({ maxLength: 100_000 }),
          payload: redisValueSchema,
          contentType: optional(string({ maxLength: 1000 })),
          persistent: boolean(),
          headers: array(
            object({ name: string({ maxLength: 10_000 }), value: string({ maxLength: 100_000 }) }),
            { maxLength: 50 },
          ),
        }),
        result: object({ published: boolean(), routed: optional(boolean()) }),
      },
      /** Removes every message of the queue after the user agrees. */
      purge: { params: object({}), result: object({ purged: boolean() }) },
      /** Deletes the queue or exchange after the user agrees. */
      deleteObject: { params: object({}), result: object({ deleted: boolean() }) },
      /** Binds this queue or exchange to another (`direction` says which way) after the user agrees. */
      addBinding: {
        params: object({
          direction: literal(...RABBIT_BINDING_DIRECTIONS),
          peer: string({ minLength: 1, maxLength: 1000 }),
          routingKey: string({ maxLength: 100_000 }),
          /** Arguments as a JSON object; empty for none. */
          arguments: string({ maxLength: 100_000 }),
        }),
        result: object({ done: boolean() }),
      },
      /** Removes the binding listed at `index` after the user agrees. */
      removeBinding: {
        params: object({ index: number({ integer: true, min: 0 }) }),
        result: object({ done: boolean() }),
      },
      /** Closes a connection after the user agrees (virtual host pages). */
      closeConnection: {
        params: object({ name: string({ minLength: 1, maxLength: 1000 }) }),
        result: object({ done: boolean() }),
      },
      createUser: {
        params: object({
          name: string({ minLength: 1, maxLength: 1000 }),
          password: string({ maxLength: 10_000 }),
          tags: array(string({ maxLength: 100 }), { maxLength: 50 }),
        }),
        result: object({ done: boolean() }),
      },
      /** Changes a user's password, tags or both; what is left out stays as it is. */
      updateUser: {
        params: object({
          name: string({ minLength: 1, maxLength: 1000 }),
          password: optional(string({ minLength: 1, maxLength: 10_000 })),
          tags: optional(array(string({ maxLength: 100 }), { maxLength: 50 })),
        }),
        result: object({ done: boolean() }),
      },
      deleteUser: {
        params: object({ name: string({ minLength: 1, maxLength: 1000 }) }),
        result: object({ done: boolean() }),
      },
      setPermission: {
        params: object({
          user: string({ minLength: 1, maxLength: 1000 }),
          configure: string({ maxLength: 10_000 }),
          write: string({ maxLength: 10_000 }),
          read: string({ maxLength: 10_000 }),
        }),
        result: object({ done: boolean() }),
      },
      clearPermission: {
        params: object({ user: string({ minLength: 1, maxLength: 1000 }) }),
        result: object({ done: boolean() }),
      },
      setPolicy: {
        params: object({
          name: string({ minLength: 1, maxLength: 1000 }),
          pattern: string({ maxLength: 10_000 }),
          applyTo: literal(...RABBIT_POLICY_TARGETS),
          priority: number({ integer: true, min: -1_000_000, max: 1_000_000 }),
          /** A JSON object. */
          definition: string({ maxLength: 1_000_000 }),
          /** Saves an operator policy (V13.39). */
          operator: optional(boolean()),
        }),
        result: object({ done: boolean() }),
      },
      deletePolicy: {
        params: object({
          name: string({ minLength: 1, maxLength: 1000 }),
          operator: optional(boolean()),
        }),
        result: object({ done: boolean() }),
      },
      /** Sets a limit of the virtual host, or lifts it when `value` is left out (V13.35). */
      setLimit: {
        params: object({
          limit: literal(...RABBIT_VHOST_LIMITS),
          value: optional(number({ integer: true, min: 0, max: 2_000_000_000 })),
        }),
        result: object({ done: boolean() }),
      },
      /** Changes the description, tags and default queue type of the virtual host (V13.39). */
      setVhostSettings: {
        params: object({
          description: string({ maxLength: 1000 }),
          tags: array(string({ maxLength: 100 }), { maxLength: 50 }),
          defaultQueueType: literal(...RABBIT_QUEUE_TYPES),
        }),
        result: object({ done: boolean() }),
      },
      /** Starts or stops the live graphs of a queue. */
      setLive: { params: object({ on: boolean() }), result: object({}) },
      /** Puts text on the clipboard (the host does it; a page may not). */
      copyText: { params: object({ text: string({ maxLength: 2_100_000 }) }), result: object({}) },
    },
    events: {
      /** The page script has started and listens for messages. */
      ready: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      /** Host → page: everything to render, after every load and change (D21). */
      state: rabbitObjectStateSchema,
    },
  },
});

export type RabbitObjectProtocol = typeof rabbitObjectProtocol;

export type RabbitObjectState = Infer<typeof rabbitObjectStateSchema>;
export type RabbitSampleView = Infer<typeof rabbitSampleSchema>;
export type RabbitMessageView = Infer<typeof rabbitMessageSchema>;
export type RabbitBindingView = Infer<typeof rabbitBindingSchema>;
export type RabbitFactView = Infer<typeof rabbitFactSchema>;
export type RabbitConsumerView = Infer<typeof rabbitConsumerSchema>;
export type RabbitConnectionView = Infer<typeof rabbitConnectionSchema>;
export type RabbitUserView = Infer<typeof rabbitUserSchema>;
export type RabbitPolicyView = Infer<typeof rabbitPolicySchema>;
export type RabbitAdminView = Infer<typeof rabbitAdminSchema>;
export type RabbitClusterView = Infer<typeof rabbitClusterSchema>;
export type RabbitNodeView = Infer<typeof rabbitNodeSchema>;

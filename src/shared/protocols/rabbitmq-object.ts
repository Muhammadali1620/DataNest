// The RabbitMQ queue and exchange page (V13.26): one panel per queue or exchange shows its
// figures, arguments and bindings, peeks at the first messages of a queue and publishes a
// message. A peek puts every message back (D156). The host runs every command and asks
// before writing to production; a read-only connection is refused there.

import { defineProtocol } from '../rpc';
import { array, boolean, literal, number, object, optional, string } from '../schema';
import type { Infer } from '../schema';
import { redisValueSchema } from './redis-key';

export const RABBIT_OBJECT_KINDS = ['queue', 'exchange'] as const;
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
export type RabbitMessageView = Infer<typeof rabbitMessageSchema>;
export type RabbitBindingView = Infer<typeof rabbitBindingSchema>;
export type RabbitFactView = Infer<typeof rabbitFactSchema>;

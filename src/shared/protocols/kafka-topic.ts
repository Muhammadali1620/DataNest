// The Kafka topic page (V13.23): one panel per topic shows its partitions with the offsets
// they hold, reads messages of one partition (the last ones, from an offset or from a
// moment in time) and sends a message. Reading never joins a group of the user's or moves
// an offset (D153). The host runs every command and asks before writing to production; a
// read-only connection is refused there.

import { defineProtocol } from '../rpc';
import { array, boolean, literal, nullable, number, object, optional, string } from '../schema';
import type { Infer } from '../schema';
import { redisValueSchema } from './redis-key';

export const KAFKA_READ_MODES = ['last', 'offset', 'time'] as const;
export type KafkaReadMode = (typeof KAFKA_READ_MODES)[number];

/** The most messages one read brings. */
export const MAX_KAFKA_COUNT = 500;
export const DEFAULT_KAFKA_COUNT = 50;

export const kafkaPartitionSchema = object({
  partition: number({ integer: true, min: 0 }),
  /** The first offset stored and the offset the next message gets (64-bit: strings). */
  low: string({ maxLength: 24 }),
  high: string({ maxLength: 24 }),
  /** -1 when the partition has no leader. */
  leader: number({ integer: true }),
  replicas: number({ integer: true, min: 0 }),
  inSync: number({ integer: true, min: 0 }),
});

export const kafkaHeaderSchema = object({
  name: string({ maxLength: 10_000 }),
  value: redisValueSchema,
});

export const kafkaMessageSchema = object({
  partition: number({ integer: true, min: 0 }),
  offset: string({ maxLength: 24 }),
  /** Milliseconds since the epoch. */
  timestamp: string({ maxLength: 24 }),
  key: nullable(redisValueSchema),
  /** Null for a tombstone. */
  value: nullable(redisValueSchema),
  headers: array(kafkaHeaderSchema, { maxLength: 200 }),
  /** Set when the key or value was written with a registry schema and shows decoded (V13.34). */
  schema: optional(
    object({ id: number({ integer: true, min: 0 }), format: literal('AVRO', 'PROTOBUF', 'JSON') }),
  ),
});

export const kafkaTopicStateSchema = object({
  topic: string({ maxLength: 1000 }),
  internal: boolean(),
  connectionName: string({ maxLength: 500 }),
  readOnly: boolean(),
  partitions: array(kafkaPartitionSchema, { maxLength: 100_000 }),
  /** What the last read asked for, so the page shows it again. */
  partition: number({ integer: true, min: 0 }),
  mode: literal(...KAFKA_READ_MODES),
  count: number({ integer: true, min: 1, max: MAX_KAFKA_COUNT }),
  messages: array(kafkaMessageSchema, { maxLength: MAX_KAFKA_COUNT }),
  /** True once a read has run; false while the page has only listed the partitions. */
  read: boolean(),
  /** What the last read did not bring, in words (a moment past the last message, …). */
  notice: optional(string({ maxLength: 1000 })),
  /** True while the page follows the partition live (V13.29). */
  tailing: optional(boolean()),
});

export const kafkaTopicProtocol = defineProtocol({
  host: {
    requests: {
      /** Lists the partitions again; the messages on the page stay. */
      refresh: { params: object({}), result: object({}) },
      /**
       * Reads messages. `offset` is the offset of mode `offset`; `time` is the moment of
       * mode `time` (anything `Date.parse` understands, or milliseconds).
       */
      read: {
        params: object({
          partition: number({ integer: true, min: 0 }),
          mode: literal(...KAFKA_READ_MODES),
          count: number({ integer: true, min: 1, max: MAX_KAFKA_COUNT }),
          offset: optional(string({ maxLength: 24 })),
          time: optional(string({ maxLength: 100 })),
        }),
        result: object({}),
      },
      /**
       * Follows new messages of a partition live, or stops doing so (V13.29). The messages
       * come as state updates; they are kept up to the most a read brings.
       */
      tail: {
        params: object({ partition: number({ integer: true, min: 0 }), on: boolean() }),
        result: object({}),
      },
      /** Sends one message; `value` null sends a tombstone. */
      produce: {
        params: object({
          partition: optional(number({ integer: true, min: 0 })),
          key: optional(redisValueSchema),
          value: nullable(redisValueSchema),
          headers: array(
            object({ name: string({ maxLength: 10_000 }), value: string({ maxLength: 100_000 }) }),
            {
              maxLength: 50,
            },
          ),
        }),
        result: object({
          produced: boolean(),
          partition: optional(number({ integer: true, min: 0 })),
          offset: optional(string({ maxLength: 24 })),
        }),
      },
      /** Deletes the topic after the user agrees. */
      deleteTopic: { params: object({}), result: object({ deleted: boolean() }) },
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
      state: kafkaTopicStateSchema,
    },
  },
});

export type KafkaTopicProtocol = typeof kafkaTopicProtocol;

export type KafkaTopicState = Infer<typeof kafkaTopicStateSchema>;
export type KafkaMessageView = Infer<typeof kafkaMessageSchema>;
export type KafkaPartitionView = Infer<typeof kafkaPartitionSchema>;

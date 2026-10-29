// The Redis key page (V7.3): one panel per key shows its type, TTL and size and lets
// the user read and change its value — a string, a hash's fields, a list, a set, a
// sorted set or a stream — a page of items at a time. The host runs every command and
// asks before writing to production; a read-only connection is refused there.

import { defineProtocol } from '../rpc';
import {
  array,
  boolean,
  type Infer,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
} from '../schema';

/** Bytes of a string value the page gets; a longer one is cut and cannot be edited. */
export const MAX_STRING_BYTES = 1_000_000;
/** Bytes of one item (field, member, element) the page gets. */
export const MAX_ITEM_BYTES = 64 * 1024;
/** Items one page of a collection holds. */
export const ITEM_PAGE_SIZE = 200;

/** Text of a value, with room for hex of the largest one sent. */
const VALUE_TEXT = MAX_STRING_BYTES * 4;

export const redisValueSchema = object({
  text: string({ maxLength: VALUE_TEXT }),
  hex: optional(string({ maxLength: MAX_STRING_BYTES * 2 })),
  truncated: optional(boolean()),
  size: optional(number({ integer: true, min: 0 })),
});

export const redisKeyRefSchema = object({
  text: string({ maxLength: 100_000 }),
  hex: optional(string({ maxLength: 200_000 })),
});

/** The types the page edits; anything else (a module's type) is shown by name only. */
export const EDITABLE_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;

export type EditableType = (typeof EDITABLE_TYPES)[number];

/**
 * One item of a collection. What is set depends on the type: `field` + `value` (hash),
 * `index` + `value` (list), `value` (set), `value` + `score` (zset), `id` + `fields`
 * (stream).
 */
const itemSchema = object({
  value: optional(redisValueSchema),
  field: optional(redisValueSchema),
  index: optional(number({ integer: true })),
  score: optional(string({ maxLength: 64 })),
  id: optional(string({ maxLength: 64 })),
  fields: optional(
    array(object({ field: redisValueSchema, value: redisValueSchema }), { maxLength: 10_000 }),
  ),
});

const keyStateSchema = object({
  key: redisKeyRefSchema,
  database: number({ integer: true, min: 0 }),
  connectionName: string({ maxLength: 500 }),
  /** The connection refuses every change. */
  readOnly: boolean(),
  /** False once the key is gone (deleted, expired). */
  exists: boolean(),
  /** `string`, `hash`, …, or a module's type name. */
  type: string({ maxLength: 100 }),
  /** Milliseconds left, or null without an expiry. */
  ttlMs: nullable(number({ integer: true })),
  /** STRLEN, HLEN, LLEN, SCARD, ZCARD or XLEN. */
  length: optional(number({ integer: true, min: 0 })),
  /** MEMORY USAGE in bytes, when the server tells. */
  memory: optional(number({ integer: true, min: 0 })),
  encoding: optional(string({ maxLength: 100 })),
  /** The value of a string. */
  value: optional(redisValueSchema),
  items: optional(array(itemSchema, { maxLength: 100_000 })),
  /** More items are there to load. */
  more: optional(boolean()),
  /** The pattern the items are filtered by (hash, set, zset). */
  filter: optional(string({ maxLength: 1000 })),
});

const valueParams = object({ value: redisValueSchema });
const fieldParams = object({ field: redisValueSchema });

export const redisKeyProtocol = defineProtocol({
  host: {
    requests: {
      /** Reads everything again, from the first page. */
      refresh: { params: object({}), result: object({}) },
      /** Appends the next page of items. */
      loadMore: { params: object({}), result: object({}) },
      /** Lists only items that match a glob; empty lists all (hash, set, zset). */
      filter: { params: object({ pattern: string({ maxLength: 1000 }) }), result: object({}) },
      /** SET, keeping the TTL. */
      setString: { params: valueParams, result: object({}) },
      /** HSET; with `previous`, the field is renamed in the same step. */
      setField: {
        params: object({
          field: redisValueSchema,
          value: redisValueSchema,
          previous: optional(redisValueSchema),
        }),
        result: object({}),
      },
      deleteField: { params: fieldParams, result: object({}) },
      /** LSET, only while the element there is still `expected`. */
      setListItem: {
        params: object({
          index: number({ integer: true }),
          expected: redisValueSchema,
          value: redisValueSchema,
        }),
        result: object({}),
      },
      /** LPUSH or RPUSH. */
      pushListItem: {
        params: object({ end: literal('head', 'tail'), value: redisValueSchema }),
        result: object({}),
      },
      /** Removes the element at `index`, only while it is still `expected`. */
      removeListItem: {
        params: object({ index: number({ integer: true }), expected: redisValueSchema }),
        result: object({}),
      },
      /** SADD; with `previous`, that member is removed in the same step. */
      setMember: {
        params: object({ value: redisValueSchema, previous: optional(redisValueSchema) }),
        result: object({}),
      },
      deleteMember: { params: valueParams, result: object({}) },
      /** ZADD; with `previous`, that member is removed in the same step. */
      setScoredMember: {
        params: object({
          value: redisValueSchema,
          score: string({ maxLength: 64 }),
          previous: optional(redisValueSchema),
        }),
        result: object({}),
      },
      /** XADD with an id of the server's (`*`) or the user's. */
      addEntry: {
        params: object({
          id: string({ maxLength: 64 }),
          /** At least one pair; the host checks. */
          fields: array(object({ field: redisValueSchema, value: redisValueSchema }), {
            maxLength: 1000,
          }),
        }),
        result: object({}),
      },
      deleteEntry: { params: object({ id: string({ maxLength: 64 }) }), result: object({}) },
      /** EXPIRE in seconds, or PERSIST for null. */
      setTtl: {
        params: object({ seconds: nullable(number({ integer: true, min: 1 })) }),
        result: object({}),
      },
      /** RENAMENX; a taken name is replaced only after the user agrees. */
      rename: {
        params: object({ name: string({ minLength: 1, maxLength: 100_000 }) }),
        result: object({ renamed: boolean() }),
      },
      /** Deletes the key after the user agrees. */
      deleteKey: { params: object({}), result: object({ deleted: boolean() }) },
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
      state: keyStateSchema,
    },
  },
});

export type RedisKeyProtocol = typeof redisKeyProtocol;

export type RedisKeyState = Infer<typeof keyStateSchema>;

export type RedisKeyItem = Infer<typeof itemSchema>;

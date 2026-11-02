// The etcd key page (V13.19): one panel per key shows its value, its revisions and the
// lease that will end it, and lets the user change the value and the lease. Every save is
// a compare-and-swap on the revision the page read, so a change made meanwhile by someone
// else is never overwritten without a question. The host runs every command and asks
// before writing to production; a read-only connection is refused there.

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
import { redisKeyRefSchema, redisValueSchema } from './redis-key';

export const leaseSchema = object({
  /** The lease's id, a decimal number (64 bits do not fit a JavaScript number). */
  id: string({ maxLength: 24 }),
  /** Seconds left. */
  ttl: number({ integer: true }),
  /** Seconds it was granted for. */
  grantedTtl: number({ integer: true }),
});

/** One change the watch saw (V13.31). */
export const etcdWatchEventSchema = object({
  /** Milliseconds since the epoch, when the host heard of it. */
  at: number({ integer: true, min: 0 }),
  type: literal('put', 'delete'),
  /** The key that changed (below the watched one when a prefix is watched). */
  key: string({ maxLength: 20_000 }),
  revision: string({ maxLength: 24 }),
  /** Bytes of the value after the change; 0 after a delete. */
  size: number({ integer: true, min: 0 }),
  /** The start of the new value as text (a hint for binary data), cut short. */
  preview: string({ maxLength: 300 }),
});

export const etcdKeyStateSchema = object({
  key: redisKeyRefSchema,
  connectionName: string({ maxLength: 500 }),
  readOnly: boolean(),
  /** False while the key is not in the store: a new key, or one deleted meanwhile. */
  exists: boolean(),
  value: optional(redisValueSchema),
  /** Bytes of the stored value. */
  size: number({ integer: true, min: 0 }),
  /** The revision of the last change: the page sends it back with a save. */
  modRevision: string({ maxLength: 24 }),
  createRevision: string({ maxLength: 24 }),
  /** Changes since the key was created. */
  version: number({ integer: true, min: 0 }),
  lease: nullable(leaseSchema),
  /** The last save was refused because the key changed after the page read it. */
  conflict: optional(boolean()),
  /** The host renews the key's lease while this page is open (V13.27). */
  keepingAlive: optional(boolean()),
  /** The host watches the key (or the keys below it) and lists what changes (V13.31). */
  watching: optional(boolean()),
  /** The watch covers every key below this one as well. */
  watchPrefix: optional(boolean()),
  /** What the watch saw, the newest last; kept after the watch stops. */
  events: optional(array(etcdWatchEventSchema, { maxLength: 200 })),
  /** Why the watch stopped by itself (the link broke, the cluster ended it). */
  watchNotice: optional(string({ maxLength: 1000 })),
});

export const etcdKeyProtocol = defineProtocol({
  host: {
    requests: {
      /** Reads the key again. */
      refresh: { params: object({}), result: object({}) },
      /**
       * Saves the value. `modRevision` is the revision the page read (`"0"` for a key that
       * was not there); a changed key is refused unless `overwrite` says the user chose
       * to replace it.
       */
      save: {
        params: object({
          value: redisValueSchema,
          modRevision: string({ maxLength: 24 }),
          overwrite: optional(boolean()),
        }),
        result: object({ saved: boolean() }),
      },
      /** Attaches a lease: a new one of `ttl` seconds, or an existing one by its id. */
      attachLease: {
        params: object({
          ttl: optional(number({ integer: true, min: 1 })),
          id: optional(string({ maxLength: 24 })),
        }),
        result: object({}),
      },
      /**
       * Starts or stops renewing the key's lease while the page is open (V13.27): the host
       * renews it every third of the time it was granted for, until the page closes, the
       * lease goes, or this is switched off.
       */
      keepAlive: { params: object({ on: boolean() }), result: object({}) },
      /**
       * Starts or stops watching the key (V13.31); with `prefix`, every key below it too.
       * Changes arrive as new states, in batches, and the page lists them.
       */
      watch: {
        params: object({ on: boolean(), prefix: optional(boolean()) }),
        result: object({}),
      },
      /** Empties the list of changes the watch saw. */
      clearEvents: { params: object({}), result: object({}) },
      /** Lets go of the key's lease; the key stays for good. */
      detachLease: { params: object({}), result: object({}) },
      /** Revokes the key's lease after the user agrees: every key it holds goes. */
      revokeLease: { params: object({}), result: object({ revoked: boolean() }) },
      /** Deletes the key after the user agrees. */
      deleteKey: { params: object({}), result: object({ deleted: boolean() }) },
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
      state: etcdKeyStateSchema,
    },
  },
});

export type EtcdKeyProtocol = typeof etcdKeyProtocol;

export type EtcdKeyState = Infer<typeof etcdKeyStateSchema>;
export type EtcdLease = Infer<typeof leaseSchema>;
export type EtcdWatchEventView = Infer<typeof etcdWatchEventSchema>;

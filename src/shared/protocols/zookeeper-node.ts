// The ZooKeeper znode page (V13.24): one panel per znode shows its data, its stat, its ACL
// and its children, and lets the user change the data and add or delete children. Every save
// is a compare-and-set on the version the page read, so a change made meanwhile by someone
// else is never overwritten without a question. The host runs every command and asks before
// writing to production; a read-only connection is refused there.

import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';
import { redisValueSchema } from './redis-key';

export const ZNODE_KINDS = ['persistent', 'ephemeral', 'container', 'ttl'] as const;

export const CREATE_MODES = ['persistent', 'sequential', 'container'] as const;

export const znodeAclSchema = object({
  /** Bit set: read 1, write 2, create 4, delete 8, admin 16. */
  perms: number({ integer: true, min: 0, max: 31 }),
  scheme: string({ maxLength: 200 }),
  id: string({ maxLength: 2000 }),
});

export const zookeeperNodeStateSchema = object({
  path: string({ maxLength: 20_000 }),
  connectionName: string({ maxLength: 500 }),
  readOnly: boolean(),
  /** False while the znode is not there: a new one, or one deleted meanwhile. */
  exists: boolean(),
  value: optional(redisValueSchema),
  /** The ACL does not let this user read the data. */
  denied: optional(boolean()),
  /** Bytes of the stored data. */
  size: number({ integer: true, min: 0 }),
  kind: literal(...ZNODE_KINDS),
  /** The version of the data: the page sends it back with a save. */
  version: number({ integer: true, min: 0 }),
  cversion: number({ integer: true, min: 0 }),
  aversion: number({ integer: true, min: 0 }),
  /** Transaction ids and the owner session, decimal. */
  czxid: string({ maxLength: 24 }),
  mzxid: string({ maxLength: 24 }),
  pzxid: string({ maxLength: 24 }),
  ephemeralOwner: string({ maxLength: 24 }),
  /** Milliseconds since the epoch. */
  ctime: number({ integer: true, min: 0 }),
  mtime: number({ integer: true, min: 0 }),
  numChildren: number({ integer: true, min: 0 }),
  acl: array(znodeAclSchema, { maxLength: 200 }),
  /** The first names of the children, sorted. */
  children: array(string({ maxLength: 2000 }), { maxLength: 1000 }),
  moreChildren: boolean(),
  /** The last save was refused because the znode changed after the page read it. */
  conflict: optional(boolean()),
  /** The last change of ACL was refused because the ACL changed after the page read it. */
  aclConflict: optional(boolean()),
});

export const zookeeperNodeProtocol = defineProtocol({
  host: {
    requests: {
      /** Reads the znode again. */
      refresh: { params: object({}), result: object({}) },
      /**
       * Saves the data. `version` is the version the page read; a changed znode is refused
       * unless `overwrite` says the user chose to replace it. A znode that is not there is
       * created.
       */
      save: {
        params: object({
          value: redisValueSchema,
          version: number({ integer: true, min: 0 }),
          overwrite: optional(boolean()),
        }),
        result: object({ saved: boolean() }),
      },
      /**
       * Replaces the ACL (V13.27). `aversion` is the ACL version the page read; a changed
       * ACL is refused. A digest entry may be typed `user:password`: the host hashes it.
       */
      saveAcl: {
        params: object({
          acl: array(znodeAclSchema, { maxLength: 200 }),
          aversion: number({ integer: true, min: 0 }),
        }),
        result: object({ saved: boolean() }),
      },
      /** Creates a child znode with empty data and opens its page. */
      createChild: {
        params: object({
          name: string({ maxLength: 2000 }),
          mode: literal(...CREATE_MODES),
        }),
        result: object({ path: string({ maxLength: 20_000 }) }),
      },
      /** Opens the page of a child. */
      openChild: { params: object({ name: string({ maxLength: 2000 }) }), result: object({}) },
      /** Deletes the znode (and everything below it) after the user agrees. */
      deleteNode: { params: object({}), result: object({ deleted: boolean() }) },
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
      state: zookeeperNodeStateSchema,
    },
  },
});

export type ZookeeperNodeProtocol = typeof zookeeperNodeProtocol;

export type ZookeeperNodeState = Infer<typeof zookeeperNodeStateSchema>;
export type ZnodeAclEntry = Infer<typeof znodeAclSchema>;

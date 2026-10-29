// Commands on the keys of a Redis database (V7.2): load more of them, filter them by
// a pattern, find one. The editor bits arrive through the deps, so the behaviour is
// covered by unit tests; the search box itself lives in find-key.ts.

import { DbError } from '../../core/errors';
import type { RedisKeyBrowser } from '../../services/redis/key-browser';
import type { LoadedKey } from '../../services/redis/key-tree';
import type { ConnectionStore } from '../../services/connection-store';
import { redisDatabaseOf } from '../../services/connection-manager';
import {
  createKey,
  deleteKeys,
  type NewKeyContent,
  renameKey,
} from '../../services/redis/key-edits';
import { type RedisKeyRef, redisKeyBytes, redisKeyId, redisKeyRef } from '../../shared/redis-key';
import {
  isTreeNode,
  type RedisDatabaseNode,
  type RedisKeyNode,
  type TreeNode,
} from '../tree/nodes';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';

/** Where a key command works: a connection and one of its numbered databases. */
export interface RedisPlace {
  readonly connectionId: string;
  readonly database: number;
}

/** The questions the key commands ask, as texts of the editor's language. */
export interface RedisKeyTexts {
  deleteKeys(names: readonly string[]): string;
  readonly deleteAction: string;
  productionDetail(connection: string): string;
  replaceKey(name: string): string;
  readonly replaceAction: string;
  /** The button of the production question. */
  readonly changeAction: string;
  readonly readOnly: string;
}

export interface RedisKeyCommandDeps {
  readonly browser: Pick<
    RedisKeyBrowser,
    'loadMore' | 'patternOf' | 'setPattern' | 'include' | 'forget' | 'session'
  >;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly tree: RefreshableTree;
  /** Asks for a glob; undefined when the user backs out, '' to show every key. */
  readonly askPattern: (current: string | undefined) => Promise<string | undefined>;
  /** Picks one of the Redis connections, for commands run from the palette. */
  readonly pickConnection: (ids: readonly string[]) => Promise<string | undefined>;
  /** Lets the user search a database and returns the key chosen. */
  readonly findKey: (place: RedisPlace, initial: string) => Promise<LoadedKey | undefined>;
  /** Shows a key in the tree, after it was put into the loaded keys. */
  readonly reveal: (place: RedisPlace, key: LoadedKey) => Promise<void>;
  /** Shown when a command needs a Redis database and none is at hand. */
  readonly noRedisMessage: string;
  /** Opens the page of a key (V7.3). */
  readonly openKey: (place: RedisPlace, key: RedisKeyRef) => Promise<void>;
  /** Asks for the name, type and first content of a new key; `prefix` starts the name. */
  readonly askNewKey: (
    prefix: string,
  ) => Promise<{ readonly name: string; readonly content: NewKeyContent } | undefined>;
  /** Asks for a new name; undefined when the user backs out. */
  readonly askName: (current: string) => Promise<string | undefined>;
  /** A modal question with one action; true when the user takes it. */
  readonly confirm: (
    message: string,
    detail: string | undefined,
    action: string,
  ) => Promise<boolean>;
  readonly texts: RedisKeyTexts;
  /** Opens a console on a database (V7.4). */
  readonly openConsole: (place: RedisPlace) => void;
  /** Opens what the server reports about itself (V7.4). */
  readonly openServerInfo: (place: RedisPlace) => void;
}

export type RedisKeyCommandName =
  | 'loadMoreKeys'
  | 'filterKeys'
  | 'findKey'
  | 'openKey'
  | 'newKey'
  | 'renameKey'
  | 'deleteKeys'
  | 'openConsole'
  | 'serverInfo';

function databaseNode(place: RedisPlace): RedisDatabaseNode {
  // The key count does not matter to refresh: nodes are matched by id.
  return {
    kind: 'redisDatabase',
    connectionId: place.connectionId,
    database: place.database,
    keys: 0,
  };
}

export function redisKeyCommandHandlers(
  deps: RedisKeyCommandDeps,
): Record<RedisKeyCommandName, (target?: CommandTarget, ...rest: unknown[]) => unknown> {
  /** The database of the clicked node, of the connection, or one the user picks. */
  const placeOf = async (target: CommandTarget): Promise<RedisPlace | undefined> => {
    if (isTreeNode(target)) {
      if (
        target.kind === 'redisDatabase' ||
        target.kind === 'redisFolder' ||
        target.kind === 'redisKey' ||
        target.kind === 'redisMore'
      ) {
        return { connectionId: target.connectionId, database: target.database };
      }
      return target.kind === 'connection' ? connectionPlace(target.connectionId) : undefined;
    }
    if (typeof target === 'string' && target !== '') {
      return connectionPlace(target);
    }
    const redis = deps.store.list().filter((config) => config.driver === 'redis');
    if (redis.length === 0) {
      throw new DbError('not-found', deps.noRedisMessage);
    }
    const chosen = await deps.pickConnection(redis.map((config) => config.id));
    return chosen === undefined ? undefined : connectionPlace(chosen);
  };

  const connectionPlace = (connectionId: string): RedisPlace => {
    const config = deps.store.get(connectionId);
    if (config?.driver !== 'redis') {
      throw new DbError('unsupported', deps.noRedisMessage);
    }
    return { connectionId, database: Number(redisDatabaseOf(config)) };
  };

  return {
    loadMoreKeys: async (target?: CommandTarget) => {
      const place = isTreeNode(target) ? await placeOf(target) : undefined;
      if (place === undefined) {
        return undefined;
      }
      await deps.browser.loadMore(place.connectionId, place.database);
      deps.tree.refresh(databaseNode(place));
      return undefined;
    },

    filterKeys: async (target?: CommandTarget) => {
      const place = await placeOf(target);
      if (place === undefined) {
        return undefined;
      }
      const pattern = await deps.askPattern(
        deps.browser.patternOf(place.connectionId, place.database),
      );
      if (pattern === undefined) {
        return undefined;
      }
      deps.browser.setPattern(place.connectionId, place.database, pattern);
      deps.tree.refresh(databaseNode(place));
      return undefined;
    },

    findKey: async (target?: CommandTarget) => {
      const place = await placeOf(target);
      if (place === undefined) {
        return undefined;
      }
      // Searching from a folder starts with its prefix.
      const initial = isTreeNode(target) && target.kind === 'redisFolder' ? target.prefix : '';
      const found = await deps.findKey(place, initial);
      if (found === undefined) {
        return undefined;
      }
      deps.browser.include(place.connectionId, place.database, found);
      await deps.reveal(place, found);
      await deps.openKey(place, found.key);
      return undefined;
    },

    openKey: async (target?: CommandTarget) => {
      if (isTreeNode(target) && target.kind === 'redisKey') {
        await deps.openKey(
          { connectionId: target.connectionId, database: target.database },
          target.key,
        );
      }
      return undefined;
    },

    newKey: async (target?: CommandTarget) => {
      const place = await placeOf(target);
      if (place === undefined || !(await mayChange(place))) {
        return undefined;
      }
      const prefix = isTreeNode(target) && target.kind === 'redisFolder' ? target.prefix : '';
      const asked = await deps.askNewKey(prefix);
      if (asked === undefined) {
        return undefined;
      }
      const key = new TextEncoder().encode(asked.name);
      await createKey(
        await deps.browser.session(place.connectionId, place.database),
        key,
        asked.content,
      );
      const ref = redisKeyRef(key);
      deps.browser.include(place.connectionId, place.database, {
        key: ref,
        type: asked.content.type,
      });
      deps.tree.refresh(databaseNode(place));
      await deps.openKey(place, ref);
      return undefined;
    },

    renameKey: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || target.kind !== 'redisKey') {
        return undefined;
      }
      const place = { connectionId: target.connectionId, database: target.database };
      if (!(await mayChange(place))) {
        return undefined;
      }
      const name = await deps.askName(target.key.text);
      if (name === undefined || name === target.key.text) {
        return undefined;
      }
      const session = await deps.browser.session(place.connectionId, place.database);
      const from = redisKeyBytes(target.key);
      const to = new TextEncoder().encode(name);
      if (!(await renameKey(session, from, to, false))) {
        if (
          !(await deps.confirm(deps.texts.replaceKey(name), undefined, deps.texts.replaceAction))
        ) {
          return undefined;
        }
        await renameKey(session, from, to, true);
      }
      deps.browser.forget(place.connectionId, place.database, target.key);
      deps.browser.include(place.connectionId, place.database, {
        key: redisKeyRef(to),
        ...(target.keyType === undefined ? {} : { type: target.keyType }),
      });
      deps.tree.refresh(databaseNode(place));
      return undefined;
    },

    openConsole: async (target?: CommandTarget) => {
      const place = await placeOf(target);
      if (place !== undefined) {
        deps.openConsole(place);
      }
      return undefined;
    },

    serverInfo: async (target?: CommandTarget) => {
      const place = await placeOf(target);
      if (place !== undefined) {
        deps.openServerInfo(place);
      }
      return undefined;
    },

    /** Deletes the clicked key, or every selected key of its database, after one question. */
    deleteKeys: async (target?: CommandTarget, selection?: unknown) => {
      if (!isTreeNode(target) || target.kind !== 'redisKey') {
        return undefined;
      }
      const place = { connectionId: target.connectionId, database: target.database };
      const chosen = (Array.isArray(selection) ? selection : [])
        .filter(isTreeNode)
        .filter(
          (node): node is RedisKeyNode =>
            node.kind === 'redisKey' &&
            node.connectionId === place.connectionId &&
            node.database === place.database,
        );
      const keys = chosen.some((node) => redisKeyId(node.key) === redisKeyId(target.key))
        ? chosen.map((node) => node.key)
        : [target.key];
      const config = deps.store.get(place.connectionId);
      if (config?.readOnly === true) {
        throw new DbError('permission-denied', deps.texts.readOnly);
      }
      const detail =
        config?.production === true ? deps.texts.productionDetail(config.name) : undefined;
      if (
        !(await deps.confirm(
          deps.texts.deleteKeys(keys.map((key) => key.text)),
          detail,
          deps.texts.deleteAction,
        ))
      ) {
        return undefined;
      }
      await deleteKeys(
        await deps.browser.session(place.connectionId, place.database),
        keys.map(redisKeyBytes),
      );
      for (const key of keys) {
        deps.browser.forget(place.connectionId, place.database, key);
      }
      deps.tree.refresh(databaseNode(place));
      return undefined;
    },
  };

  /** Read-only refuses; production asks once (V4.6). */
  async function mayChange(place: RedisPlace): Promise<boolean> {
    const config = deps.store.get(place.connectionId);
    if (config?.readOnly === true) {
      throw new DbError('permission-denied', deps.texts.readOnly);
    }
    if (config?.production !== true) {
      return true;
    }
    return await deps.confirm(
      deps.texts.productionDetail(config.name),
      undefined,
      deps.texts.changeAction,
    );
  }
}

/** The tree node of a key in a database, as the tree builds it: named by its last segment. */
export function keyNodeOf(place: RedisPlace, entry: LoadedKey, separator: string): TreeNode {
  return {
    kind: 'redisKey',
    connectionId: place.connectionId,
    database: place.database,
    key: entry.key,
    name: separator === '' ? entry.key.text : (entry.key.text.split(separator).at(-1) ?? ''),
    ...(entry.type === undefined ? {} : { keyType: entry.type }),
  };
}

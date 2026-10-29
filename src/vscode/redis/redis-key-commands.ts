// Commands on the keys of a Redis database (V7.2): load more of them, filter them by
// a pattern, find one. The editor bits arrive through the deps, so the behaviour is
// covered by unit tests; the search box itself lives in find-key.ts.

import { DbError } from '../../core/errors';
import type { RedisKeyBrowser } from '../../services/redis/key-browser';
import type { LoadedKey } from '../../services/redis/key-tree';
import type { ConnectionStore } from '../../services/connection-store';
import { redisDatabaseOf } from '../../services/connection-manager';
import { isTreeNode, type RedisDatabaseNode, type TreeNode } from '../tree/nodes';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';

/** Where a key command works: a connection and one of its numbered databases. */
export interface RedisPlace {
  readonly connectionId: string;
  readonly database: number;
}

export interface RedisKeyCommandDeps {
  readonly browser: Pick<RedisKeyBrowser, 'loadMore' | 'patternOf' | 'setPattern' | 'include'>;
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
}

export type RedisKeyCommandName = 'loadMoreKeys' | 'filterKeys' | 'findKey';

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
): Record<RedisKeyCommandName, (target?: CommandTarget) => unknown> {
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
      return undefined;
    },
  };
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

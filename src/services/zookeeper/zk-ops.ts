// What the browser does with the znodes of a session (V13.24): reading one with its ACL
// and children, counting and deleting a subtree, and the paged listing the tree uses. They
// take the narrow `ZookeeperCaller` so the tests need no server.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { ZookeeperAcl, ZookeeperSession, ZookeeperStat } from '../../drivers/zookeeper-driver';
import { joinPath, ROOT_PATH } from '../../shared/zk-path';

export type ZookeeperCaller = Pick<
  ZookeeperSession,
  'children' | 'getData' | 'exists' | 'getAcl' | 'setAcl' | 'create' | 'setData' | 'remove'
>;

/** Requests that run together while the stats of a page, or a subtree, are read. */
export const CONCURRENCY = 32;

/** Nodes counted at most when a subtree is measured. */
export const COUNT_LIMIT = 100_000;

/** What a stat says when the ACL lets nobody but the owner read the znode, not even its stat. */
export const UNKNOWN_STAT: ZookeeperStat = {
  czxid: '0',
  mzxid: '0',
  pzxid: '0',
  ephemeralOwner: '0',
  ctime: 0,
  mtime: 0,
  version: 0,
  cversion: 0,
  aversion: 0,
  dataLength: 0,
  numChildren: 0,
};

/** What the page of a znode shows. */
export interface ZnodeDetails {
  /** `UNKNOWN_STAT` when `data` is undefined and the stat could not be read either. */
  readonly stat: ZookeeperStat;
  /** The data; undefined when the user's ACL does not allow reading it. */
  readonly data: Uint8Array | undefined;
  readonly acl: readonly ZookeeperAcl[];
  /** The first names of the children, sorted. */
  readonly children: readonly string[];
  /** The children listing was cut: there are more names than are shown. */
  readonly moreChildren: boolean;
}

/** Children the page of a znode lists at most. */
export const PAGE_CHILDREN = 200;

function isDenied(error: unknown): boolean {
  return error instanceof DbError && error.code === 'permission-denied';
}

/** Compares names by their code units, so the order does not depend on the locale. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads a znode with its data, ACL and children; undefined when it does not exist. */
export async function readNode(
  session: ZookeeperCaller,
  path: string,
): Promise<ZnodeDetails | undefined> {
  let data: Uint8Array | undefined;
  let stat: ZookeeperStat;
  try {
    const read = await session.getData(path);
    data = read.data;
    stat = read.stat;
  } catch (error) {
    if (error instanceof DbError && error.code === 'not-found') {
      return undefined;
    }
    if (!isDenied(error)) {
      throw error;
    }
    // The ACL does not let this user read the data. ZooKeeper wants the same permission
    // (read) for the stat, the ACL and the children, so most likely nothing can be shown;
    // the znode is there, which is all the refusal says.
    try {
      const known = await session.exists(path);
      if (known === undefined) {
        return undefined;
      }
      stat = known;
    } catch (inner) {
      if (!isDenied(inner)) {
        throw inner;
      }
      return { stat: UNKNOWN_STAT, data: undefined, acl: [], children: [], moreChildren: false };
    }
  }
  const [acl, children] = await Promise.all([
    session.getAcl(path).then(
      (answer) => answer.acl,
      (error: unknown) => {
        if (isDenied(error)) {
          return [] as readonly ZookeeperAcl[];
        }
        throw error;
      },
    ),
    session.children(path).then(
      (answer) => [...answer.names].sort(compareNames),
      (error: unknown) => {
        if (isDenied(error)) {
          return [] as string[];
        }
        throw error;
      },
    ),
  ]);
  return {
    stat,
    data,
    acl,
    children: children.slice(0, PAGE_CHILDREN),
    moreChildren: children.length > PAGE_CHILDREN,
  };
}

/** Runs `task` over `items`, `CONCURRENCY` at a time, and returns the results in order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

export interface TreeCount {
  /** Znodes in the subtree, the root of it included. */
  readonly count: number;
  /** The count stopped at the limit. */
  readonly capped: boolean;
}

/** Counts a subtree, walking it breadth first; stops at `limit` znodes. */
export async function countTree(
  session: ZookeeperCaller,
  path: string,
  limit = COUNT_LIMIT,
  signal?: AbortSignal,
): Promise<TreeCount> {
  let count = 0;
  let level: string[] = [path];
  while (level.length > 0) {
    if (signal?.aborted === true) {
      return { count, capped: true };
    }
    count += level.length;
    if (count >= limit) {
      return { count: limit, capped: true };
    }
    const names = await mapLimited(level, async (node) => {
      try {
        return (await session.children(node)).names.map((name) => joinPath(node, name));
      } catch (error) {
        // A node that went meanwhile has nothing below it.
        if (error instanceof DbError && error.code === 'not-found') {
          return [];
        }
        throw error;
      }
    });
    level = names.flat();
  }
  return { count, capped: false };
}

/**
 * Deletes a znode and everything below it, children first. A znode that is already gone
 * counts as deleted. Returns how many znodes this call deleted.
 */
export async function deleteTree(
  session: ZookeeperCaller,
  path: string,
  signal?: AbortSignal,
): Promise<number> {
  if (path === ROOT_PATH) {
    throw new DbError('unsupported', msg('The root znode cannot be deleted'));
  }
  // Collect the whole subtree first (parents before children), then delete it backwards.
  const levels: string[][] = [];
  let level: string[] = [path];
  while (level.length > 0) {
    levels.push(level);
    const next = await mapLimited(level, async (node) => {
      try {
        return (await session.children(node)).names.map((name) => joinPath(node, name));
      } catch (error) {
        if (error instanceof DbError && error.code === 'not-found') {
          return [];
        }
        throw error;
      }
    });
    level = next.flat();
  }
  let deleted = 0;
  for (const nodes of levels.reverse()) {
    if (signal?.aborted === true) {
      throw new DbError('cancelled', msg('Cancelled'));
    }
    const results = await mapLimited<string, number>(nodes, async (node) => {
      try {
        await session.remove(node, -1);
        return 1;
      } catch (error) {
        if (error instanceof DbError && error.code === 'not-found') {
          return 0;
        }
        throw error;
      }
    });
    deleted += results.reduce((sum, one) => sum + one, 0);
  }
  return deleted;
}

export interface AclTreeResult {
  /** Znodes below the start whose ACL was replaced. */
  readonly changed: number;
  /** Znodes below the start whose ACL could not be replaced or read, with the first reasons. */
  readonly failed: number;
  readonly failures: readonly { readonly path: string; readonly message: string }[];
  /** The walk stopped at the limit; the znodes after it were not reached. */
  readonly capped: boolean;
}

/** Reasons kept of the znodes that refused. */
export const MAX_ACL_FAILURES = 10;

/**
 * Gives every znode below `path` (not `path` itself) the same ACL, breadth first (V13.31).
 * The ACLs are replaced whatever version they are at: they are being overwritten on purpose.
 * A znode the user may not change, or may not list, is counted as failed and skipped; the
 * rest goes on. Ephemeral znodes are changed like the others.
 */
export async function applyAclTree(
  session: ZookeeperCaller,
  path: string,
  acl: readonly ZookeeperAcl[],
  limit = COUNT_LIMIT,
  signal?: AbortSignal,
): Promise<AclTreeResult> {
  let changed = 0;
  let failed = 0;
  let reached = 0;
  const failures: { path: string; message: string }[] = [];
  const fail = (node: string, error: unknown): void => {
    failed += 1;
    if (failures.length < MAX_ACL_FAILURES) {
      failures.push({
        path: node,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  let level: string[] = [path];
  while (level.length > 0) {
    if (signal?.aborted === true) {
      return { changed, failed, failures, capped: true };
    }
    const next = await mapLimited(level, async (node): Promise<string[]> => {
      let names: readonly string[];
      try {
        names = (await session.children(node)).names;
      } catch (error) {
        // A node that went meanwhile has nothing below it; a refusal is a failure to list.
        if (!(error instanceof DbError && error.code === 'not-found')) {
          fail(node, error);
        }
        return [];
      }
      return names.map((name) => joinPath(node, name));
    });
    level = next.flat();
    const room = limit - reached;
    const capped = level.length > room;
    if (capped) {
      level = level.slice(0, Math.max(0, room));
    }
    reached += level.length;
    await mapLimited(level, async (node) => {
      try {
        await session.setAcl(node, acl, -1);
        changed += 1;
      } catch (error) {
        if (!(error instanceof DbError && error.code === 'not-found')) {
          fail(node, error);
        }
      }
    });
    if (capped) {
      return { changed, failed, failures, capped: true };
    }
  }
  return { changed, failed, failures, capped: false };
}

// What the tree knows about the znodes of a ZooKeeper connection (V13.24): for each znode
// opened, the names of its children (ZooKeeper lists them all in one answer, sorted here),
// the stats of the pages shown so far and where the next page starts. A znode is read when it
// is first opened; "load more" brings the next page; refreshing the tree forgets it all, so
// the next look asks the server again.

import { DbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ZookeeperStat } from '../../drivers/zookeeper-driver';
import { joinPath, kindOfOwner, type ZnodeKind } from '../../shared/zk-path';
import { ConnectionManager } from '../connection-manager';
import { compareNames, mapLimited } from './zk-ops';

/** Children a page asks for when no setting says otherwise. */
export const DEFAULT_CHILDREN_PER_LOAD = 300;

export interface ZookeeperBrowserSettings {
  /** `datanest.zookeeper.childrenPerLoad`; asked at every load, so a change applies at once. */
  childrenPerLoad(): number;
}

export interface ZookeeperBrowserDeps {
  readonly manager: Pick<ConnectionManager, 'acquireZookeeper'>;
  readonly settings?: ZookeeperBrowserSettings;
  readonly logger: Logger;
}

export interface NodeEntry {
  readonly name: string;
  readonly path: string;
  /** Children it has. */
  readonly numChildren: number;
  readonly kind: ZnodeKind;
  /** Bytes of data it holds. */
  readonly dataLength: number;
  /** The ACL lets this user read nothing of it, not even how many children it has. */
  readonly denied?: boolean;
}

export interface NodeListing {
  readonly entries: readonly NodeEntry[];
  /** More children follow the ones read. */
  readonly more: boolean;
  /** All children, read or not. */
  readonly total: number;
}

interface NodeState {
  names: string[] | undefined;
  entries: NodeEntry[];
  next: number;
  loading: Promise<void> | undefined;
}

function stateKey(connectionId: string, path: string): string {
  return `${connectionId}\u0000${path}`;
}

export function entryOf(parent: string, name: string, stat: ZookeeperStat): NodeEntry {
  return {
    name,
    path: joinPath(parent, name),
    numChildren: stat.numChildren,
    kind: kindOfOwner(stat.ephemeralOwner),
    dataLength: stat.dataLength,
  };
}

/** A child whose stat the ACL does not let this user read. */
export function deniedEntry(parent: string, name: string): NodeEntry {
  return {
    name,
    path: joinPath(parent, name),
    numChildren: 0,
    kind: 'persistent',
    dataLength: 0,
    denied: true,
  };
}

export class ZookeeperNodeBrowser {
  private readonly states = new Map<string, NodeState>();
  private readonly logger: Logger;

  constructor(private readonly deps: ZookeeperBrowserDeps) {
    this.logger = deps.logger.child('zookeeper-nodes');
  }

  /** The children of a znode, reading the first page when it has not been opened yet. */
  async children(connectionId: string, path: string): Promise<NodeListing> {
    const state = this.stateOf(connectionId, path);
    if (state.names === undefined && state.loading === undefined) {
      await this.load(connectionId, path, state);
    } else if (state.loading !== undefined) {
      await state.loading;
    }
    return this.listing(state);
  }

  /** Reads the next page of a znode, if there is one. */
  async loadMore(connectionId: string, path: string): Promise<void> {
    const state = this.stateOf(connectionId, path);
    if (state.names === undefined || state.next >= state.names.length) {
      return;
    }
    await this.load(connectionId, path, state);
  }

  /** Forgets what was read, of one connection or of all. */
  reset(connectionId?: string): void {
    for (const key of [...this.states.keys()]) {
      if (connectionId === undefined || key.startsWith(`${connectionId}\u0000`)) {
        this.states.delete(key);
      }
    }
  }

  private listing(state: NodeState): NodeListing {
    const total = state.names?.length ?? 0;
    return { entries: state.entries, more: state.next < total, total };
  }

  private stateOf(connectionId: string, path: string): NodeState {
    const key = stateKey(connectionId, path);
    let state = this.states.get(key);
    if (state === undefined) {
      state = { names: undefined, entries: [], next: 0, loading: undefined };
      this.states.set(key, state);
    }
    return state;
  }

  private async load(connectionId: string, path: string, state: NodeState): Promise<void> {
    if (state.loading !== undefined) {
      await state.loading;
      return;
    }
    const loading = (async (): Promise<void> => {
      const session = await this.deps.manager.acquireZookeeper(
        ConnectionManager.treeOwner(connectionId),
        { connectionId },
      );
      state.names ??= [...(await session.children(path)).names].sort(compareNames);
      const size = this.deps.settings?.childrenPerLoad() ?? DEFAULT_CHILDREN_PER_LOAD;
      const page = state.names.slice(state.next, state.next + size);
      const stats = await mapLimited<string, { name: string; stat?: ZookeeperStat; denied?: true }>(
        page,
        async (name) => {
          try {
            const stat = await session.exists(joinPath(path, name));
            return stat === undefined ? { name } : { name, stat };
          } catch (error) {
            // A child the ACL hides is listed all the same, marked.
            if (error instanceof DbError && error.code === 'permission-denied') {
              return { name, denied: true };
            }
            throw error;
          }
        },
      );
      // A child that went between the listing and the stat is left out.
      state.entries = [
        ...state.entries,
        ...stats.flatMap(({ name, stat, denied }): NodeEntry[] => {
          if (denied === true) {
            return [deniedEntry(path, name)];
          }
          return stat === undefined ? [] : [entryOf(path, name, stat)];
        }),
      ];
      state.next += page.length;
    })();
    state.loading = loading;
    try {
      await loading;
    } catch (error) {
      // A failed read is forgotten, so expanding again tries again.
      this.logger.warn('Reading the znodes failed', error);
      this.states.delete(stateKey(connectionId, path));
      throw error;
    } finally {
      state.loading = undefined;
    }
  }
}

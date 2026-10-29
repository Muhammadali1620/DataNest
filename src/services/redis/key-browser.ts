// What the tree knows about the keys of each Redis database (V7.2): the keys loaded so
// far, the filter pattern and where SCAN stopped. A load brings one portion; the tree
// shows a "load more" leaf until SCAN has walked the whole database.

import type { Logger } from '../../core/logging/logger';
import type { RedisSession } from '../../drivers/redis-driver';
import type { RedisKeyRef } from '../../shared/redis-key';
import { ConnectionManager } from '../connection-manager';
import { SCAN_START, type ScanPosition, scanFrom, withTypes } from './key-scan';
import { type KeyChildren, KeyTree, type LoadedKey } from './key-tree';

/** Settings the browser reads; asked every time, so a change applies at the next load. */
export interface KeyBrowserSettings {
  /** `datanest.redis.keySeparator`: what splits names into folders. */
  separator(): string;
  /** `datanest.redis.keysPerLoad`: how many keys one load brings. */
  keysPerLoad(): number;
}

export interface KeyBrowserDeps {
  readonly manager: Pick<ConnectionManager, 'acquireRedis'>;
  readonly settings: KeyBrowserSettings;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** How long one load may walk before it shows what it has. */
export const LOAD_BUDGET_MS = 2000;

interface DatabaseKeys {
  pattern: string | undefined;
  tree: KeyTree;
  position: ScanPosition;
  /** Set once a first load has run, so expanding again does not load again. */
  loaded: boolean;
  loading: Promise<void> | undefined;
}

export interface KeyListing extends KeyChildren {
  /** SCAN has not walked the whole database yet. */
  readonly more: boolean;
  /** Keys loaded in the whole database. */
  readonly loaded: number;
  readonly pattern: string | undefined;
}

function stateKey(connectionId: string, database: number): string {
  return `${connectionId}\u0000${database}`;
}

export class RedisKeyBrowser {
  private readonly states = new Map<string, DatabaseKeys>();
  private readonly logger: Logger;

  constructor(private readonly deps: KeyBrowserDeps) {
    this.logger = deps.logger.child('redis-keys');
  }

  /** The tree session of a database: every database has its own (D28, D81). */
  async session(connectionId: string, database: number): Promise<RedisSession> {
    return await this.deps.manager.acquireRedis(
      ConnectionManager.treeOwner(connectionId, String(database)),
      { connectionId, database: String(database) },
    );
  }

  /** The children of a folder (`[]` is the database), loading the first portion once. */
  async children(
    connectionId: string,
    database: number,
    path: readonly string[],
  ): Promise<KeyListing> {
    const state = this.state(connectionId, database);
    if (!state.loaded) {
      await this.load(connectionId, database);
    }
    const tree = this.treeOf(state);
    return {
      ...tree.children(path),
      more: !state.position.done,
      loaded: tree.size,
      pattern: state.pattern,
    };
  }

  /** Brings the next portion of keys; concurrent calls share one load. */
  async loadMore(connectionId: string, database: number): Promise<void> {
    await this.load(connectionId, database);
  }

  patternOf(connectionId: string, database: number): string | undefined {
    return this.states.get(stateKey(connectionId, database))?.pattern;
  }

  /** Shows only keys that match a glob from now on; undefined or `*` shows all. */
  setPattern(connectionId: string, database: number, pattern: string | undefined): void {
    const trimmed = pattern?.trim();
    this.states.set(
      stateKey(connectionId, database),
      this.fresh(trimmed === undefined || trimmed === '' || trimmed === '*' ? undefined : trimmed),
    );
  }

  /** Forgets what was loaded, keeping each database's filter. */
  reset(connectionId?: string, database?: number): void {
    for (const [key, state] of this.states) {
      const [id, number] = key.split('\u0000');
      if (
        (connectionId === undefined || id === connectionId) &&
        (database === undefined || Number(number) === database)
      ) {
        this.states.set(key, this.fresh(state.pattern));
      }
    }
  }

  /** Puts a key found elsewhere (a search) into the tree, so it can be shown there. */
  include(connectionId: string, database: number, entry: LoadedKey): void {
    this.treeOf(this.state(connectionId, database)).add([entry]);
  }

  /** Takes a deleted key out of the tree. */
  forget(connectionId: string, database: number, key: RedisKeyRef): void {
    this.states.get(stateKey(connectionId, database))?.tree.remove(key);
  }

  /** The folder path a key shows under, with the current separator. */
  folderOf(connectionId: string, database: number, key: RedisKeyRef): string[] {
    return this.treeOf(this.state(connectionId, database)).folderOf(key);
  }

  private state(connectionId: string, database: number): DatabaseKeys {
    const key = stateKey(connectionId, database);
    let state = this.states.get(key);
    if (state === undefined) {
      state = this.fresh(undefined);
      this.states.set(key, state);
    }
    return state;
  }

  private fresh(pattern: string | undefined): DatabaseKeys {
    return {
      pattern,
      tree: new KeyTree(this.deps.settings.separator()),
      position: SCAN_START,
      loaded: false,
      loading: undefined,
    };
  }

  /** The tree with the current separator; a changed setting regroups what is loaded. */
  private treeOf(state: DatabaseKeys): KeyTree {
    const separator = this.deps.settings.separator();
    if (state.tree.separator !== separator) {
      const regrouped = new KeyTree(separator);
      regrouped.add(state.tree.entries());
      state.tree = regrouped;
    }
    return state.tree;
  }

  private async load(connectionId: string, database: number): Promise<void> {
    const state = this.state(connectionId, database);
    if (state.loading !== undefined) {
      await state.loading;
      return;
    }
    const running = (async () => {
      const session = await this.session(connectionId, database);
      const scanned = await scanFrom(session, state.position, {
        ...(state.pattern === undefined ? {} : { match: state.pattern }),
        want: Math.max(1, this.deps.settings.keysPerLoad()),
        budgetMs: LOAD_BUDGET_MS,
        ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
      });
      const typed = await withTypes(session, scanned.keys);
      // A reset while this load ran replaced the state: what was read belongs to nobody.
      if (this.states.get(stateKey(connectionId, database)) !== state) {
        return;
      }
      this.treeOf(state).add(typed);
      state.position = scanned.position;
      state.loaded = true;
      this.logger.debug(
        `Loaded ${typed.length} keys of database ${database} (${this.treeOf(state).size} in all)`,
      );
    })();
    state.loading = running;
    try {
      await running;
    } finally {
      state.loading = undefined;
    }
  }
}

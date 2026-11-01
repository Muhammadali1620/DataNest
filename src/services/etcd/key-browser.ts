// What the tree knows about the folders of an etcd connection (V13.19): for each folder
// opened, the children read so far and where the next page starts. A folder is read when
// it is first opened; "load more" brings the next page; refreshing the tree forgets it
// all, so the next look asks the cluster again.

import type { Logger } from '../../core/logging/logger';
import { type RedisKeyRef, redisKeyBytes, redisKeyId } from '../../shared/redis-key';
import { ConnectionManager } from '../connection-manager';
import { type ListEntry, listPage } from './key-listing';

/** Keys a page asks for when no setting says otherwise. */
export const DEFAULT_KEYS_PER_LOAD = 300;

export interface EtcdBrowserSettings {
  /** `datanest.etcd.keysPerLoad`; asked at every load, so a change applies at once. */
  keysPerLoad(): number;
}

export interface EtcdBrowserDeps {
  readonly manager: Pick<ConnectionManager, 'acquireEtcd'>;
  readonly settings?: EtcdBrowserSettings;
  readonly logger: Logger;
}

export interface FolderListing {
  readonly entries: readonly ListEntry[];
  /** More children follow the ones read. */
  readonly more: boolean;
}

interface FolderState {
  entries: ListEntry[];
  next: Uint8Array | undefined;
  loading: Promise<void> | undefined;
}

function stateKey(connectionId: string, prefix: RedisKeyRef): string {
  return `${connectionId}\u0000${redisKeyId(prefix)}`;
}

/** The root folder: no prefix, every key. */
export const ROOT: RedisKeyRef = { text: '' };

export class EtcdKeyBrowser {
  private readonly states = new Map<string, FolderState>();
  private readonly logger: Logger;

  constructor(private readonly deps: EtcdBrowserDeps) {
    this.logger = deps.logger.child('etcd-keys');
  }

  /** The children of a folder, reading the first page when it has not been opened yet. */
  async children(connectionId: string, prefix: RedisKeyRef): Promise<FolderListing> {
    const state = this.stateOf(connectionId, prefix);
    if (state.entries.length === 0 && state.next === undefined && state.loading === undefined) {
      await this.load(connectionId, prefix, state);
    } else if (state.loading !== undefined) {
      await state.loading;
    }
    return { entries: state.entries, more: state.next !== undefined };
  }

  /** Reads the next page of a folder, if there is one. */
  async loadMore(connectionId: string, prefix: RedisKeyRef): Promise<void> {
    const state = this.stateOf(connectionId, prefix);
    if (state.next === undefined) {
      return;
    }
    await this.load(connectionId, prefix, state);
  }

  /** Forgets what was read, of one connection or of all. */
  reset(connectionId?: string): void {
    for (const key of [...this.states.keys()]) {
      if (connectionId === undefined || key.startsWith(`${connectionId}\u0000`)) {
        this.states.delete(key);
      }
    }
  }

  private stateOf(connectionId: string, prefix: RedisKeyRef): FolderState {
    const key = stateKey(connectionId, prefix);
    let state = this.states.get(key);
    if (state === undefined) {
      state = { entries: [], next: undefined, loading: undefined };
      this.states.set(key, state);
    }
    return state;
  }

  private async load(connectionId: string, prefix: RedisKeyRef, state: FolderState): Promise<void> {
    if (state.loading !== undefined) {
      await state.loading;
      return;
    }
    const loading = (async (): Promise<void> => {
      const session = await this.deps.manager.acquireEtcd(
        ConnectionManager.treeOwner(connectionId),
        { connectionId },
      );
      const size = this.deps.settings?.keysPerLoad() ?? DEFAULT_KEYS_PER_LOAD;
      const page = await listPage(session, redisKeyBytes(prefix), state.next, size);
      state.entries = [...state.entries, ...page.entries];
      state.next = page.next;
    })();
    state.loading = loading;
    try {
      await loading;
    } catch (error) {
      // A failed read is forgotten, so expanding again tries again.
      this.logger.warn('Reading the keys failed', error);
      this.states.delete(stateKey(connectionId, prefix));
      throw error;
    } finally {
      state.loading = undefined;
    }
  }
}

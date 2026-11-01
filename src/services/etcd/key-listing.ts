// Folders made of key names (V13.19). etcd keeps one flat, sorted key space; the tree
// shows `/app/db/host` as folders by splitting at the slash. Nothing is read ahead: a
// folder's children come from a range over its prefix, folded by the next slash, and
// when a folder holds more keys than one call returns the rest of it is skipped with a
// jump to the first key after the folder — so the work follows the number of children
// shown, not the number of keys below them.

import { type RedisKeyRef, redisKeyBytes, redisKeyRef } from '../../shared/redis-key';
import { displayKey } from '../../shared/redis-key';
import { afterKey, concatBytes, prefixEnd, startsWith } from './etcd-codec';
import { countPrefix, type EtcdCaller, range } from './etcd-client';

/** The byte that splits a key into folders. */
export const SLASH = 0x2f;

/** Keys one call to the cluster reads while folding. */
const READ_AHEAD = 1000;

/** Calls one page may make at most; a page of nothing but huge folders still ends. */
const MAX_CALLS = 20;

/** Folders whose size is asked for in one page, and how many asks run together. */
const COUNTED_FOLDERS = 60;
const COUNT_CONCURRENCY = 6;

export interface FolderEntry {
  readonly kind: 'folder';
  /** The folder's prefix, slash included: the keys below it all start with it. */
  readonly prefix: RedisKeyRef;
  /** The folder's own name. */
  readonly label: string;
  /** The keys below it, when the cluster was asked. */
  readonly count?: number;
}

export interface LeafEntry {
  readonly kind: 'key';
  readonly key: RedisKeyRef;
  /** The name inside the folder. */
  readonly label: string;
  /** The key dies with a lease. */
  readonly leased: boolean;
}

export type ListEntry = FolderEntry | LeafEntry;

export interface ListPage {
  readonly entries: readonly ListEntry[];
  /** Where the next page starts; absent when the folder has been read to its end. */
  readonly next?: Uint8Array;
}

/**
 * One page of the children of a folder. `cursor` is the `next` of the page before; the
 * page ends at the first stop after `pageSize` children, which may overshoot a little,
 * because it never stops inside one read.
 */
export async function listPage(
  session: EtcdCaller,
  prefix: Uint8Array,
  cursor: Uint8Array | undefined,
  pageSize: number,
): Promise<ListPage> {
  const end = prefixEnd(prefix);
  const entries: ListEntry[] = [];
  let start = cursor ?? prefix;
  let last: Uint8Array | undefined;
  for (let call = 0; call < MAX_CALLS; call += 1) {
    const { entries: keys, more } = await range(session, start, {
      end,
      limit: READ_AHEAD,
      keysOnly: true,
    });
    let openFolder: Uint8Array | undefined;
    for (const { key, lease } of keys) {
      last = key;
      const rest = key.subarray(prefix.length);
      const slash = rest.indexOf(SLASH);
      if (slash < 0) {
        entries.push({
          kind: 'key',
          key: redisKeyRef(key),
          // A key that is the folder's own name has nothing left to show.
          label: rest.length === 0 ? displayKey(key) : displayKey(rest),
          leased: lease !== '0',
        });
        openFolder = undefined;
        continue;
      }
      const folder = key.subarray(0, prefix.length + slash + 1);
      if (openFolder !== undefined && sameBytes(openFolder, folder)) {
        continue;
      }
      openFolder = folder;
      entries.push({
        kind: 'folder',
        prefix: redisKeyRef(Uint8Array.from(folder)),
        label: displayKey(rest.subarray(0, slash)),
      });
    }
    if (!more || last === undefined) {
      return { entries: await withCounts(session, entries) };
    }
    // The next read starts after the last key; inside a folder it skips the rest of it.
    const lastFolder = entries[entries.length - 1];
    start =
      lastFolder?.kind === 'folder' && startsWith(last, redisKeyBytes(lastFolder.prefix))
        ? prefixEnd(redisKeyBytes(lastFolder.prefix))
        : afterKey(last);
    if (entries.length >= pageSize) {
      return { entries: await withCounts(session, entries), next: start };
    }
  }
  return { entries: await withCounts(session, entries), next: start };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Puts the number of keys on the first folders of a page, a few asks at a time. */
async function withCounts(
  session: EtcdCaller,
  entries: readonly ListEntry[],
): Promise<ListEntry[]> {
  const result = [...entries];
  const folders = result
    .map((entry, index) => ({ entry, index }))
    .filter((item): item is { entry: FolderEntry; index: number } => item.entry.kind === 'folder')
    .slice(0, COUNTED_FOLDERS);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < folders.length) {
      const item = folders[next];
      next += 1;
      if (item === undefined) {
        return;
      }
      try {
        const total = await countPrefix(session, redisKeyBytes(item.entry.prefix));
        result[item.index] = { ...item.entry, count: total };
      } catch {
        // A folder without a number is still a folder.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, folders.length) }, worker));
  return result;
}

export interface FoundKeys {
  readonly keys: readonly RedisKeyRef[];
  /** The prefix matches more keys than were asked for. */
  readonly more: boolean;
}

/** The keys that start with `prefix`, names only, for the search command. */
export async function findKeys(
  session: EtcdCaller,
  prefix: Uint8Array,
  limit: number,
): Promise<FoundKeys> {
  const { entries, more } = await range(session, prefix, {
    end: prefixEnd(prefix),
    limit,
    keysOnly: true,
  });
  return { keys: entries.map((entry) => redisKeyRef(entry.key)), more };
}

/** `prefix` + `name` as bytes: where a key typed by the user lives. */
export function joinKey(prefix: Uint8Array, name: Uint8Array): Uint8Array {
  return concatBytes(prefix, name);
}

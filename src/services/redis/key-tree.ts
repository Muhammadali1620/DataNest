// The loaded keys of a Redis database, grouped into folders by a separator (V7.2):
// `user:1:name` lives in `user` → `1`. A folder counts every key below it. Only what
// SCAN has brought so far is here; the tree offers to load more.

import { type RedisKeyRef, redisKeyId } from '../../shared/redis-key';

export interface LoadedKey {
  readonly key: RedisKeyRef;
  /** `string`, `hash`, …, or a module's type; absent when the server did not say. */
  readonly type?: string;
}

export interface KeyFolder {
  /** The segment this folder stands for. */
  readonly name: string;
  /** Every segment from the top, this folder's last. */
  readonly path: readonly string[];
  /** Keys below it, at any depth. */
  readonly count: number;
}

export interface KeyLeaf {
  /** The last segment of the key: what the tree shows inside its folder. */
  readonly name: string;
  readonly entry: LoadedKey;
}

export interface KeyChildren {
  readonly folders: readonly KeyFolder[];
  readonly keys: readonly KeyLeaf[];
}

class Branch {
  readonly folders = new Map<string, Branch>();
  readonly keys = new Map<string, KeyLeaf>();
  count = 0;
}

// Numbers sort as numbers, so `user:2` comes before `user:10`.
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class KeyTree {
  private readonly root = new Branch();
  private readonly all = new Map<string, LoadedKey>();

  /** `separator` splits names into folders; an empty one keeps every key at the top. */
  constructor(readonly separator: string) {}

  get size(): number {
    return this.all.size;
  }

  /** Every key, in the order it was added. */
  entries(): LoadedKey[] {
    return [...this.all.values()];
  }

  has(key: RedisKeyRef): boolean {
    return this.all.has(redisKeyId(key));
  }

  /** Adds keys; one already present keeps its place and takes the newer type. */
  add(entries: readonly LoadedKey[]): void {
    for (const entry of entries) {
      const id = redisKeyId(entry.key);
      const known = this.all.has(id);
      this.all.set(id, entry);
      const segments = this.segmentsOf(entry.key);
      let branch = this.root;
      if (!known) {
        branch.count += 1;
      }
      for (const segment of segments.slice(0, -1)) {
        let next = branch.folders.get(segment);
        if (next === undefined) {
          next = new Branch();
          branch.folders.set(segment, next);
        }
        branch = next;
        if (!known) {
          branch.count += 1;
        }
      }
      branch.keys.set(id, { name: segments.at(-1) ?? '', entry });
    }
  }

  /** Takes a key out, with the folders it leaves empty. Absent keys are ignored. */
  remove(key: RedisKeyRef): void {
    const id = redisKeyId(key);
    if (!this.all.delete(id)) {
      return;
    }
    const segments = this.segmentsOf(key);
    const trail: Branch[] = [this.root];
    for (const segment of segments.slice(0, -1)) {
      const next = trail.at(-1)?.folders.get(segment);
      if (next === undefined) {
        break;
      }
      trail.push(next);
    }
    trail.at(-1)?.keys.delete(id);
    for (const branch of trail) {
      branch.count -= 1;
    }
    for (let depth = trail.length - 1; depth > 0; depth--) {
      if (trail[depth]?.count === 0) {
        trail[depth - 1]?.folders.delete(segments[depth - 1] ?? '');
      }
    }
  }

  /** The folders and keys right inside a folder (the top for `[]`), each sorted by name. */
  children(path: readonly string[]): KeyChildren {
    let branch: Branch | undefined = this.root;
    for (const segment of path) {
      branch = branch.folders.get(segment);
      if (branch === undefined) {
        return { folders: [], keys: [] };
      }
    }
    const folders = [...branch.folders.entries()]
      .map(([name, child]) => ({ name, path: [...path, name], count: child.count }))
      .sort((a, b) => COLLATOR.compare(a.name, b.name));
    const keys = [...branch.keys.values()].sort((a, b) => COLLATOR.compare(a.name, b.name));
    return { folders, keys };
  }

  /** The folder path a key is shown in. */
  folderOf(key: RedisKeyRef): string[] {
    return this.segmentsOf(key).slice(0, -1);
  }

  private segmentsOf(key: RedisKeyRef): string[] {
    return this.separator === '' ? [key.text] : key.text.split(this.separator);
  }
}

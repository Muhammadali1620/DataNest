// The last server version seen behind each connection, so the tree can show it before
// the connection is opened (V11.15). The entry belongs to where the connection points:
// when the driver, host, port, socket or file changes it is forgotten, so an old
// version is never shown for a different server.

import type { ConnectionInput } from '../shared/connection';

/** The slice of `vscode.Memento` this needs. */
export interface MemoryStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const VERSION_MEMORY_KEY = 'datanest.serverVersions';

interface Entry {
  readonly version: string;
  /** Where the connection pointed when the version was read. */
  readonly target: string;
}

type Entries = Readonly<Record<string, Entry>>;

type Target = Pick<ConnectionInput, 'driver' | 'host' | 'port' | 'socket' | 'file'>;

/** Everything that makes it another server; the name, user and password are not part of it. */
export function versionTarget(config: Target): string {
  return [
    config.driver,
    config.host ?? '',
    config.port ?? '',
    config.socket ?? '',
    config.file ?? '',
  ]
    .map(String)
    .join('\u0000');
}

export class VersionMemory {
  constructor(private readonly storage: MemoryStorage) {}

  private entries(): Entries {
    const stored = this.storage.get(VERSION_MEMORY_KEY);
    return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Entries)
      : {};
  }

  /** The version last seen for the connection, if it still points where it did. */
  recall(id: string, config: Target): string | undefined {
    const entry = this.entries()[id];
    if (
      typeof entry?.version !== 'string' ||
      entry.version === '' ||
      entry.target !== versionTarget(config)
    ) {
      return undefined;
    }
    return entry.version;
  }

  /** Writes only when something changed, so a refresh does not touch the state. */
  async remember(id: string, config: Target, version: string): Promise<void> {
    const target = versionTarget(config);
    const current = this.entries()[id];
    if (current?.version === version && current.target === target) {
      return;
    }
    await this.storage.update(VERSION_MEMORY_KEY, { ...this.entries(), [id]: { version, target } });
  }

  /** Drops the entries of connections that are gone (and any that no longer match). */
  async prune(live: ReadonlyMap<string, Target>): Promise<void> {
    const entries = this.entries();
    const kept: Record<string, Entry> = {};
    for (const [id, entry] of Object.entries(entries)) {
      const config = live.get(id);
      if (config !== undefined && entry.target === versionTarget(config)) {
        kept[id] = entry;
      }
    }
    if (Object.keys(kept).length !== Object.keys(entries).length) {
      await this.storage.update(VERSION_MEMORY_KEY, kept);
    }
  }
}

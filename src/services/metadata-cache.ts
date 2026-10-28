// Keeps structure reads off the server while the user browses the tree and types
// in the editor (ARCHITECTURE.md §7). Entries live until something invalidates them:
// Refresh, a statement that changes structure, or a connection changing state.

import { changesStructure } from '../core/sql/statement-kind';
import type { Logger } from '../core/logging/logger';
import type { ObjectScope, TableRef } from '../core/model/objects';
import type { MetadataReader } from '../drivers/driver';

interface Entry {
  /** The in-flight or settled read; identical calls share it. */
  readonly value: Promise<unknown>;
}

export interface MetadataCacheDeps {
  readonly logger: Logger;
}

/**
 * Wraps the metadata reader of a session. The wrapper is cheap to create: all state
 * lives in the cache, keyed by connection, so wrapping the same connection again
 * (after a reconnect) keeps whatever is already cached.
 */
export class MetadataCache {
  private readonly logger: Logger;
  /** connectionId → cache key → entry. */
  private readonly entries = new Map<string, Map<string, Entry>>();

  constructor(deps: MetadataCacheDeps) {
    this.logger = deps.logger.child('metadata');
  }

  /** How many connections currently hold cached reads; for tests and logs. */
  get size(): number {
    return this.entries.size;
  }

  /** A reader that answers from the cache and falls back to `reader`. */
  wrap(connectionId: string, reader: MetadataReader): MetadataReader {
    return {
      listDatabases: async () =>
        await this.read(connectionId, 'databases', async () => await reader.listDatabases()),
      listSchemas: async (database?: string) =>
        await this.read(
          connectionId,
          `schemas:${database ?? ''}`,
          async () => await reader.listSchemas(database),
        ),
      listTables: async (scope: ObjectScope) =>
        await this.read(
          connectionId,
          `tables:${scopeKey(scope)}`,
          async () => await reader.listTables(scope),
        ),
      listColumns: async (table: TableRef) =>
        await this.read(
          connectionId,
          `columns:${scopeKey(table)}:${table.name}`,
          async () => await reader.listColumns(table),
        ),
      listForeignKeys: async (table: TableRef) =>
        await this.read(
          connectionId,
          `foreign:${scopeKey(table)}:${table.name}`,
          async () => await reader.listForeignKeys(table),
        ),
      listUniqueKeys: async (table: TableRef) =>
        await this.read(
          connectionId,
          `unique:${scopeKey(table)}:${table.name}`,
          async () => await reader.listUniqueKeys(table),
        ),
      // A definition is read when the user asks for it and must be the current one.
      getDefinition: async (object) => await reader.getDefinition(object),
    };
  }

  /** Drops everything cached for one connection, or for all of them. */
  invalidate(connectionId?: string): void {
    if (connectionId === undefined) {
      this.entries.clear();
      this.logger.debug('Dropped all cached metadata');
      return;
    }
    if (this.entries.delete(connectionId)) {
      this.logger.debug(`Dropped cached metadata of ${connectionId}`);
    }
  }

  /**
   * Called after a statement ran. A statement that may have changed the structure
   * drops the connection's cache, so the tree and completion see the new state.
   */
  noteStatement(connectionId: string, sql: string): void {
    if (changesStructure(sql)) {
      this.invalidate(connectionId);
    }
  }

  private async read<T>(connectionId: string, key: string, load: () => Promise<T>): Promise<T> {
    const forConnection = this.entries.get(connectionId) ?? new Map<string, Entry>();
    this.entries.set(connectionId, forConnection);
    const cached = forConnection.get(key);
    if (cached) {
      return (await cached.value) as T;
    }
    const value = load();
    forConnection.set(key, { value });
    try {
      return await value;
    } catch (error) {
      // A failed read is never cached: the next attempt must reach the server.
      if (forConnection.get(key)?.value === value) {
        forConnection.delete(key);
      }
      if (forConnection.size === 0) {
        this.entries.delete(connectionId);
      }
      throw error;
    }
  }
}

function scopeKey(scope: ObjectScope): string {
  return `${scope.database ?? ''}/${scope.schema ?? ''}`;
}

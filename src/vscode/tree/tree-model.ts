// Decides what every tree node contains. Free of `vscode`: the provider only turns
// these nodes into TreeItems, so the whole structure is unit-tested with fakes.

import { DbError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ObjectScope } from '../../core/model/objects';
import { withoutSystemDatabases, withoutSystemSchemas } from '../../core/model/system-objects';
import type { DriverCapabilities, MetadataReader } from '../../drivers/driver';
import { browseSession } from '../../services/browse-session';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import type { DriverId } from '../../shared/connection';
import type { TreeNode } from './nodes';

export interface TreeTexts {
  readonly tables: string;
  readonly views: string;
  readonly noTables: string;
  readonly noViews: string;
  readonly noDatabases: string;
  readonly noColumns: string;
}

/** Settings the tree reads; asked every time, so a change takes effect at once. */
export interface TreeSettings {
  /** `datanest.showSystemObjects`: show the server's own databases and schemas. */
  showSystemObjects(): boolean;
}

export interface TreeModelDeps {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly settings: TreeSettings;
  readonly logger: Logger;
  readonly texts: TreeTexts;
}

export class TreeModel {
  private readonly deps: TreeModelDeps;
  private readonly logger: Logger;

  constructor(deps: TreeModelDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('tree');
  }

  /** Saved connections, in the order the user keeps them. */
  roots(): TreeNode[] {
    return this.deps.store.list().map((config) => ({
      kind: 'connection' as const,
      connectionId: config.id,
    }));
  }

  /**
   * Children of a node. A failure never breaks the tree: it becomes a leaf that
   * says what went wrong, and the details go to the log.
   */
  async children(node: TreeNode): Promise<TreeNode[]> {
    try {
      return await this.listChildren(node);
    } catch (error) {
      this.logger.warn(`Could not list children of ${node.kind}`, error);
      return [
        {
          kind: 'message',
          text: errorMessage(error),
          failed: true,
          ...('connectionId' in node && node.connectionId !== undefined
            ? { connectionId: node.connectionId }
            : {}),
        },
      ];
    }
  }

  private async listChildren(node: TreeNode): Promise<TreeNode[]> {
    switch (node.kind) {
      case 'connection':
        return await this.connectionChildren(node.connectionId);
      case 'database':
        return await this.databaseChildren(node.connectionId, node.database);
      case 'schema':
        return this.groups(node.connectionId, {
          ...(node.database === undefined ? {} : { database: node.database }),
          schema: node.schema,
        });
      case 'group':
        return await this.groupChildren(node.connectionId, node.scope, node.group);
      case 'table':
        return await this.columnChildren(node);
      case 'column':
      case 'message':
        return [];
    }
  }

  /** Expanding a connection connects it: that is what the user means by it. */
  private async connectionChildren(connectionId: string): Promise<TreeNode[]> {
    const capabilities = await this.capabilitiesOf(connectionId);
    const metadata = await this.metadataOf(connectionId);
    if (!capabilities.databases) {
      // A single-file database (SQLite): objects sit right under the connection.
      return this.groups(connectionId, {});
    }
    const all = await metadata.listDatabases();
    // Filtering happens here, not in the cache: toggling the setting needs no
    // server round trip, and the cache keeps what the server actually said.
    const databases = this.deps.settings.showSystemObjects()
      ? all
      : withoutSystemDatabases(this.driverIdOf(connectionId), all);
    if (databases.length === 0) {
      return [{ kind: 'message', text: this.deps.texts.noDatabases, connectionId }];
    }
    return databases.map((database) => ({ kind: 'database', connectionId, database }));
  }

  private async databaseChildren(connectionId: string, database: string): Promise<TreeNode[]> {
    const capabilities = await this.capabilitiesOf(connectionId);
    if (!capabilities.schemas) {
      return this.groups(connectionId, { database });
    }
    const metadata = await this.metadataOf(connectionId, database);
    const all = await metadata.listSchemas(database);
    const schemas = this.deps.settings.showSystemObjects()
      ? all
      : withoutSystemSchemas(this.driverIdOf(connectionId), all);
    return schemas.map((schema) => ({ kind: 'schema', connectionId, database, schema }));
  }

  private groups(connectionId: string, scope: ObjectScope): TreeNode[] {
    return [
      { kind: 'group', group: 'tables', connectionId, scope },
      { kind: 'group', group: 'views', connectionId, scope },
    ];
  }

  private async groupChildren(
    connectionId: string,
    scope: ObjectScope,
    group: 'tables' | 'views',
  ): Promise<TreeNode[]> {
    const metadata = await this.metadataOf(connectionId, scope.database);
    const wanted = group === 'tables' ? 'table' : 'view';
    const found = (await metadata.listTables(scope)).filter((table) => table.kind === wanted);
    if (found.length === 0) {
      return [
        {
          kind: 'message',
          text: group === 'tables' ? this.deps.texts.noTables : this.deps.texts.noViews,
          connectionId,
        },
      ];
    }
    return found.map((table) => ({
      kind: 'table',
      connectionId,
      scope,
      name: table.name,
      tableKind: table.kind,
    }));
  }

  private async columnChildren(node: Extract<TreeNode, { kind: 'table' }>): Promise<TreeNode[]> {
    const metadata = await this.metadataOf(node.connectionId, node.scope.database);
    const columns = await metadata.listColumns({ ...node.scope, name: node.name });
    if (columns.length === 0) {
      return [
        { kind: 'message', text: this.deps.texts.noColumns, connectionId: node.connectionId },
      ];
    }
    return columns.map((column) => ({
      kind: 'column',
      connectionId: node.connectionId,
      table: { ...node.scope, name: node.name },
      column,
    }));
  }

  /** The driver of a saved connection; an unknown id cannot reach here. */
  private driverIdOf(connectionId: string): DriverId {
    const config = this.deps.store.get(connectionId);
    if (!config) {
      throw new DbError('not-found', `Connection "${connectionId}" does not exist`);
    }
    return config.driver;
  }

  private async capabilitiesOf(connectionId: string): Promise<DriverCapabilities> {
    return (await this.deps.manager.driverOf(connectionId)).capabilities;
  }

  /** The tree shares the browsing session of a connection (`browseSession`). */
  private async metadataOf(connectionId: string, database?: string): Promise<MetadataReader> {
    const session = await browseSession(this.deps.manager, connectionId, database);
    return this.deps.cache.wrap(connectionId, session.metadata);
  }
}

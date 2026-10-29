// Decides what every tree node contains. Free of `vscode`: the provider only turns
// these nodes into TreeItems, so the whole structure is unit-tested with fakes.

import { DbError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ListedObjectKind, ObjectScope, TableRef } from '../../core/model/objects';
import { withoutSystemDatabases, withoutSystemSchemas } from '../../core/model/system-objects';
import { filterNames } from '../../shared/name-filter';
import type { DriverCapabilities, MetadataReader } from '../../drivers/driver';
import { browseSession } from '../../services/browse-session';
import { ConnectionManager, redisDatabaseOf } from '../../services/connection-manager';
import { listRedisDatabases } from '../../services/redis/redis-databases';
import type { RedisKeyBrowser } from '../../services/redis/key-browser';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import type { ProjectView } from '../../services/project-connections';
import type { ConnectionConfig, DriverId } from '../../shared/connection';
import {
  GROUP_OF_KIND,
  KIND_OF_GROUP,
  type FolderNode,
  type ObjectFolder,
  type ObjectGroup,
  type TableFolder,
  type TreeNode,
} from './nodes';

/** What a project node says when it has nothing to list (V4.7). */
export interface ProjectTexts {
  /** The workspace is in Restricted Mode; `{count}` connections are listed. */
  untrusted(count: number): string;
  broken(error: string): string;
  /** An entry of the file was skipped; `position` counts from 1. */
  skipped(position: number, problem: string): string;
  readonly empty: string;
}

export interface TreeTexts {
  /** What an empty folder of connections says. */
  readonly emptyFolder?: string;
  readonly project?: ProjectTexts;
  readonly tables: string;
  readonly views: string;
  readonly noTables: string;
  readonly noViews: string;
  readonly noDatabases: string;
  readonly noColumns: string;
  /** How many keys a Redis database holds (V7.1). */
  readonly redisKeys?: (count: number) => string;
  /** A Redis database or folder without keys (V7.2); the filter when one is set. */
  readonly noKeys?: (pattern: string | undefined) => string;
  /** The leaf after a list the connection's filter shortened (V4.10). */
  readonly hiddenByFilter?: (count: number) => string;
  /** What an empty folder says, per folder. */
  readonly empty: Readonly<Record<ObjectFolder | TableFolder, string>>;
}

/** Settings the tree reads; asked every time, so a change takes effect at once. */
export interface TreeSettings {
  /** `datanest.showSystemObjects`: show the server's own databases and schemas. */
  showSystemObjects(): boolean;
}

/** Where the project files of the workspace are read from. */
export interface ProjectSource {
  views(): ProjectView[];
}

export interface TreeModelDeps {
  readonly store: ConnectionStore;
  /** The loaded keys of Redis databases (V7.2). */
  readonly redisKeys?: RedisKeyBrowser;
  /** `datanest.redis.keySeparator`, for the prefix a folder copies. */
  readonly redisKeySeparator?: () => string;
  readonly projects?: ProjectSource;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly settings: TreeSettings;
  readonly logger: Logger;
  readonly texts: TreeTexts;
}

export class TreeModel {
  private readonly deps: TreeModelDeps;
  private readonly logger: Logger;
  /** Key counts of Redis databases as last listed, for nodes rebuilt as parents. */
  private readonly redisCounts = new Map<string, number>();

  constructor(deps: TreeModelDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('tree');
  }

  /**
   * The open project's connections first (they belong to the code in front of the
   * user), then folders, then the connections outside any folder, in the user's order.
   */
  roots(): TreeNode[] {
    const projects = (this.deps.projects?.views() ?? []).map((view): TreeNode => ({
      kind: 'project',
      key: view.folder.key,
      name: view.folder.name,
    }));
    const folders = this.deps.store
      .folders()
      .map((folder): TreeNode => ({ kind: 'connectionFolder', folder }));
    const loose = this.ownConnections()
      .filter((config) => config.folder === undefined)
      .map((config): TreeNode => ({ kind: 'connection', connectionId: config.id }));
    return [...projects, ...folders, ...loose];
  }

  /** The connections of a project file, and a leaf for whatever could not be used. */
  projectChildren(key: string): TreeNode[] {
    const view = this.deps.projects?.views().find((one) => one.folder.key === key);
    const texts = this.deps.texts.project;
    if (view === undefined || texts === undefined) {
      return [];
    }
    switch (view.status) {
      case 'untrusted':
        return [{ kind: 'message', text: texts.untrusted(view.listed) }];
      case 'broken':
        return [{ kind: 'message', text: texts.broken(view.error ?? ''), failed: true }];
      case 'ok': {
        const connections = view.connections.map((config): TreeNode => ({
          kind: 'connection',
          connectionId: config.id,
        }));
        const skipped = view.problems.map((problem): TreeNode => ({
          kind: 'message',
          text: texts.skipped(problem.position, problem.problem),
          failed: true,
        }));
        return connections.length + skipped.length === 0
          ? [{ kind: 'message', text: texts.empty }]
          : [...connections, ...skipped];
      }
    }
  }

  /** The user's own connections; project ones live under their project node. */
  private ownConnections(): ReturnType<ConnectionStore['list']> {
    return this.deps.store
      .list()
      .filter((config) => this.deps.store.projectOf(config.id) === undefined);
  }

  /** The connections of one folder; a leaf that says so when there are none. */
  connectionsInFolder(folder: string): TreeNode[] {
    const connections = this.ownConnections()
      .filter((config) => config.folder === folder)
      .map((config): TreeNode => ({ kind: 'connection', connectionId: config.id }));
    if (connections.length > 0 || this.deps.texts.emptyFolder === undefined) {
      return connections;
    }
    return [{ kind: 'message', text: this.deps.texts.emptyFolder, folder }];
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
      case 'project':
        return this.projectChildren(node.key);
      case 'connectionFolder':
        return this.connectionsInFolder(node.folder);
      case 'connection':
        return await this.connectionChildren(node.connectionId);
      case 'database':
        return await this.databaseChildren(node.connectionId, node.database);
      case 'schema':
        return await this.groups(node.connectionId, {
          ...(node.database === undefined ? {} : { database: node.database }),
          schema: node.schema,
        });
      case 'group':
        return await this.groupChildren(node.connectionId, node.scope, node.group);
      case 'table':
        return await this.tableChildren(node);
      case 'folder':
        return await this.folderChildren(node);
      case 'redisDatabase':
        return await this.redisKeyChildren(node.connectionId, node.database, []);
      case 'redisFolder':
        return await this.redisKeyChildren(node.connectionId, node.database, node.path);
      case 'column':
      case 'object':
      case 'index':
      case 'foreignKey':
      case 'redisKey':
      case 'redisMore':
      case 'message':
        return [];
    }
  }

  /**
   * The parent of a Redis node, so a key found by a search can be revealed in the
   * tree (V7.2); other nodes are never revealed and have none.
   */
  parentOf(node: TreeNode): TreeNode | undefined {
    switch (node.kind) {
      case 'redisKey':
      case 'redisFolder': {
        const path =
          node.kind === 'redisKey'
            ? (this.deps.redisKeys?.folderOf(node.connectionId, node.database, node.key) ?? [])
            : node.path.slice(0, -1);
        return path.length === 0
          ? this.redisDatabaseNode(node.connectionId, node.database)
          : this.redisFolderNode(node.connectionId, node.database, path, 0);
      }
      case 'redisMore':
        return this.redisDatabaseNode(node.connectionId, node.database);
      case 'redisDatabase':
        return { kind: 'connection', connectionId: node.connectionId };
      case 'connection': {
        const project = this.deps.store.projectOf(node.connectionId);
        if (project !== undefined) {
          return { kind: 'project', key: project.key, name: project.name };
        }
        const folder = this.deps.store.get(node.connectionId)?.folder;
        return folder === undefined ? undefined : { kind: 'connectionFolder', folder };
      }
      case 'project':
      case 'connectionFolder':
      case 'database':
      case 'schema':
      case 'group':
      case 'table':
      case 'column':
      case 'folder':
      case 'object':
      case 'index':
      case 'foreignKey':
      case 'message':
        return undefined;
    }
  }

  /** "12 keys", for the description of a Redis database. */
  redisKeysText(count: number): string {
    return this.deps.texts.redisKeys?.(count) ?? String(count);
  }

  /** Expanding a connection connects it: that is what the user means by it. */
  private async connectionChildren(connectionId: string): Promise<TreeNode[]> {
    if (this.driverIdOf(connectionId) === 'redis') {
      return await this.redisDatabases(connectionId);
    }
    const capabilities = await this.capabilitiesOf(connectionId);
    const metadata = await this.metadataOf(connectionId);
    if (!capabilities.databases) {
      // A single-file database (SQLite): objects sit right under the connection.
      return await this.groups(connectionId, {});
    }
    const all = await metadata.listDatabases();
    // Filtering happens here, not in the cache: toggling the setting needs no
    // server round trip, and the cache keeps what the server actually said.
    const unfiltered = this.deps.settings.showSystemObjects()
      ? all
      : withoutSystemDatabases(this.driverIdOf(connectionId), all);
    const databases = filterNames(unfiltered, this.configOf(connectionId).filter?.databases ?? []);
    const nodes: TreeNode[] = databases.map((database) => ({
      kind: 'database',
      connectionId,
      database,
    }));
    const hidden = this.hiddenLeaf(connectionId, unfiltered.length - databases.length);
    if (nodes.length === 0 && hidden.length === 0) {
      return [{ kind: 'message', text: this.deps.texts.noDatabases, connectionId }];
    }
    return [...nodes, ...hidden];
  }

  /** The numbered databases of a Redis connection, with their key counts (V7.1). */
  private async redisDatabases(connectionId: string): Promise<TreeNode[]> {
    const config = this.configOf(connectionId);
    const opened = Number(redisDatabaseOf(config));
    const session = await this.deps.manager.acquireRedis(
      ConnectionManager.treeOwner(connectionId, String(opened)),
      { connectionId },
    );
    const databases = await listRedisDatabases(session, opened);
    for (const database of databases) {
      this.redisCounts.set(`${connectionId}\u0000${database.index}`, database.keys);
    }
    return databases.map((database) =>
      this.redisDatabaseNode(connectionId, database.index, database.keys),
    );
  }

  private redisDatabaseNode(connectionId: string, database: number, keys?: number): TreeNode {
    return {
      kind: 'redisDatabase',
      connectionId,
      database,
      keys: keys ?? this.redisCounts.get(`${connectionId}\u0000${database}`) ?? 0,
    };
  }

  private redisFolderNode(
    connectionId: string,
    database: number,
    path: readonly string[],
    count: number,
  ): TreeNode {
    const separator = this.deps.redisKeys === undefined ? ':' : this.separatorOf();
    return {
      kind: 'redisFolder',
      connectionId,
      database,
      path,
      prefix: `${path.join(separator)}${separator}`,
      count,
    };
  }

  private separatorOf(): string {
    return this.deps.redisKeySeparator?.() ?? ':';
  }

  /** Folders, then keys, then "load more" while SCAN has not reached the end (V7.2). */
  private async redisKeyChildren(
    connectionId: string,
    database: number,
    path: readonly string[],
  ): Promise<TreeNode[]> {
    const browser = this.deps.redisKeys;
    if (browser === undefined) {
      return [];
    }
    const listing = await browser.children(connectionId, database, path);
    const nodes: TreeNode[] = [
      ...listing.folders.map((folder) =>
        this.redisFolderNode(connectionId, database, folder.path, folder.count),
      ),
      ...listing.keys.map((leaf): TreeNode => ({
        kind: 'redisKey',
        connectionId,
        database,
        key: leaf.entry.key,
        name: leaf.name,
        ...(leaf.entry.type === undefined ? {} : { keyType: leaf.entry.type }),
      })),
    ];
    if (path.length > 0) {
      return nodes;
    }
    if (listing.more) {
      nodes.push({ kind: 'redisMore', connectionId, database, loaded: listing.loaded });
    } else if (nodes.length === 0 && this.deps.texts.noKeys !== undefined) {
      nodes.push({ kind: 'message', text: this.deps.texts.noKeys(listing.pattern), connectionId });
    }
    return nodes;
  }

  /** "N hidden by the filter", so a missing database does not look like a lost one. */
  private hiddenLeaf(connectionId: string, count: number): TreeNode[] {
    const text = this.deps.texts.hiddenByFilter;
    return count > 0 && text !== undefined
      ? [{ kind: 'message', text: text(count), connectionId }]
      : [];
  }

  private async databaseChildren(connectionId: string, database: string): Promise<TreeNode[]> {
    const capabilities = await this.capabilitiesOf(connectionId);
    if (!capabilities.schemas) {
      return await this.groups(connectionId, { database });
    }
    const metadata = await this.metadataOf(connectionId, database);
    const all = await metadata.listSchemas(database);
    const unfiltered = this.deps.settings.showSystemObjects()
      ? all
      : withoutSystemSchemas(this.driverIdOf(connectionId), all);
    const schemas = filterNames(unfiltered, this.configOf(connectionId).filter?.schemas ?? []);
    return [
      ...schemas.map((schema): TreeNode => ({ kind: 'schema', connectionId, database, schema })),
      ...this.hiddenLeaf(connectionId, unfiltered.length - schemas.length),
    ];
  }

  /** Tables and views, then the folders of whatever else this database keeps. */
  private async groups(connectionId: string, scope: ObjectScope): Promise<TreeNode[]> {
    const { objectKinds } = await this.capabilitiesOf(connectionId);
    const groups: ObjectGroup[] = [
      'tables',
      'views',
      ...objectKinds.flatMap((kind) => (kind === 'trigger' ? [] : [GROUP_OF_KIND[kind]])),
    ];
    return groups.map((group) => ({ kind: 'group', group, connectionId, scope }));
  }

  private async groupChildren(
    connectionId: string,
    scope: ObjectScope,
    group: ObjectGroup,
  ): Promise<TreeNode[]> {
    if (group !== 'tables' && group !== 'views') {
      return await this.objectChildren(
        connectionId,
        scope,
        KIND_OF_GROUP[group],
        () => true,
        group,
      );
    }
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
      ...(table.materialized === true ? { materialized: true } : {}),
    }));
  }

  /** Objects of one kind in a scope, narrowed by `keep`; an empty list says so. */
  private async objectChildren(
    connectionId: string,
    scope: ObjectScope,
    kind: ListedObjectKind,
    keep: (object: { table?: string }) => unknown,
    folder: keyof TreeTexts['empty'],
  ): Promise<TreeNode[]> {
    const metadata = await this.metadataOf(connectionId, scope.database);
    const found = (await metadata.listObjects(scope, kind)).filter((object) => keep(object));
    if (found.length === 0) {
      return [{ kind: 'message', text: this.deps.texts.empty[folder], connectionId }];
    }
    return found.map((object) => ({
      kind: 'object',
      connectionId,
      object: {
        ...scope,
        kind: object.kind,
        name: object.name,
        ...(object.signature === undefined ? {} : { signature: object.signature }),
        ...(object.table === undefined ? {} : { table: object.table }),
      },
    }));
  }

  /** Columns first; a table also gets its Indexes, Foreign Keys and Triggers folders. */
  private async tableChildren(node: Extract<TreeNode, { kind: 'table' }>): Promise<TreeNode[]> {
    const columns = await this.columnChildren(node);
    if (node.tableKind !== 'table') {
      return columns;
    }
    const table: TableRef = { ...node.scope, name: node.name };
    const folders: TableFolder[] = ['indexes', 'foreignKeys', 'triggers'];
    return [
      ...columns,
      ...folders.map((folder) => ({
        kind: 'folder' as const,
        folder,
        connectionId: node.connectionId,
        table,
      })),
    ];
  }

  private async folderChildren(node: FolderNode): Promise<TreeNode[]> {
    const { connectionId, table } = node;
    const scope: ObjectScope = {
      ...(table.database === undefined ? {} : { database: table.database }),
      ...(table.schema === undefined ? {} : { schema: table.schema }),
    };
    const empty = (): TreeNode[] => [
      { kind: 'message', text: this.deps.texts.empty[node.folder], connectionId },
    ];
    const metadata = await this.metadataOf(connectionId, table.database);
    switch (node.folder) {
      case 'indexes': {
        const indexes = await metadata.listIndexes(table);
        return indexes.length === 0
          ? empty()
          : indexes.map((index) => ({ kind: 'index', connectionId, table, index }));
      }
      case 'foreignKeys': {
        const keys = await metadata.listForeignKeys(table);
        return keys.length === 0
          ? empty()
          : keys.map((key) => ({ kind: 'foreignKey', connectionId, table, key }));
      }
      case 'triggers':
        return await this.objectChildren(
          connectionId,
          scope,
          'trigger',
          (object) => object.table === table.name,
          'triggers',
        );
    }
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
    return this.configOf(connectionId).driver;
  }

  private configOf(connectionId: string): ConnectionConfig {
    const config = this.deps.store.get(connectionId);
    if (!config) {
      throw new DbError('not-found', `Connection "${connectionId}" does not exist`);
    }
    return config;
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

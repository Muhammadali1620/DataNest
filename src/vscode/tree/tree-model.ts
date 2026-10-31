// Decides what every tree node contains. Free of `vscode`: the provider only turns
// these nodes into TreeItems, so the whole structure is unit-tested with fakes.

import { DbError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ListedObjectKind, ObjectScope, TableRef, TableStats } from '../../core/model/objects';
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
  mongoCollectionChildren,
  mongoDatabaseChildren,
  mongoIndexChildren,
  type MongoTreeDeps,
} from './mongo-tree';
import {
  elasticFieldChildren,
  elasticIndexChildren,
  elasticSubfields,
  type ElasticTreeDeps,
} from './elastic-tree';
import { canMoveColumns } from '../../services/column-reorder';
import { hasAccounts } from '../../services/users/account-list';
import {
  type AccountInfo,
  GROUP_OF_KIND,
  KIND_OF_GROUP,
  type FolderNode,
  type GroupNode,
  nodeId,
  type ObjectFolder,
  type ObjectGroup,
  type SecurityGroup,
  type SecurityGroupNode,
  type TableFolder,
  type TreeNode,
} from './nodes';
import { normalizeTableFilter, tableFilter } from './table-filter';
import { msg } from '../../core/user-message';

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
  /** A MongoDB database without collections (V7.5). */
  readonly noCollections?: string;
  /** An Elasticsearch cluster without indices, an index without fields (V7.8). */
  readonly noIndices?: string;
  readonly noFields?: string;
  /** The leaf after a list the connection's filter shortened (V4.10). */
  readonly hiddenByFilter?: (count: number) => string;
  /** What an empty folder says, per folder; the Columns folder says `noColumns`. */
  readonly empty: Readonly<Record<ObjectFolder | Exclude<TableFolder, 'columns'>, string>>;
  /** A "Query" folder without saved queries (V11.12). */
  readonly noQueries?: string;
  /** A Users or Roles folder without entries (V11.12). */
  readonly noAccounts?: (group: SecurityGroup) => string;
}

/** The saved queries of a scope (V11.12); the tree lists their names. */
export interface SavedQuerySource {
  list(connectionId: string, scope: ObjectScope): Promise<readonly string[]>;
}

/** Settings the tree reads; asked every time, so a change takes effect at once. */
export interface TreeSettings {
  /** `datanest.showSystemObjects`: show the server's own databases and schemas. */
  showSystemObjects(): boolean;
  /** `datanest.tree.tableStats`: rows, size and comment of tables (V10.2.3). */
  tableStats?(): boolean;
  /** `datanest.tree.showSizes`: server version and database/schema sizes (V11.14). */
  showSizes?(): boolean;
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
  /** Without it a connection has no "Security" folder (V11.12). */
  readonly accounts?: (connectionId: string) => Promise<readonly AccountInfo[]>;
  /** Without it a database and a schema have no "Query" folder (V11.12). */
  readonly savedQueries?: SavedQuerySource;
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
  /** The Filter… text of Tables and Views folders, by node id; for this session only. */
  private readonly groupFilters = new Map<string, string>();
  /** How many children a folder had when it was last listed, by node id (V11.12). */
  private readonly counts = new Map<string, number>();
  /** Accounts as last listed, so Users and Roles do not ask the server twice. */
  private readonly accountLists = new Map<string, readonly AccountInfo[]>();

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

  /** The number of children a folder holds, once it has been listed; undefined before. */
  countOf(node: TreeNode): number | undefined {
    return this.counts.get(nodeId(node));
  }

  private remember(node: TreeNode, count: number | undefined): void {
    if (count !== undefined) {
      this.counts.set(nodeId(node), count);
    }
  }

  /** A count that is only decoration: a failure leaves it out and is logged. */
  private async tryCount(count: () => Promise<number>): Promise<number | undefined> {
    try {
      return await count();
    } catch (error) {
      this.logger.warn('Could not count the children of a folder', error);
      return undefined;
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
        return await this.groupChildren(node);
      case 'table':
        return await this.tableChildren(node);
      case 'folder':
        return await this.folderChildren(node);
      case 'queryFolder':
        return await this.queryChildren(node);
      case 'security':
        return await this.securityChildren(node.connectionId);
      case 'securityGroup':
        return await this.accountChildren(node);
      case 'redisDatabase':
        return await this.redisKeyChildren(node.connectionId, node.database, []);
      case 'redisFolder':
        return await this.redisKeyChildren(node.connectionId, node.database, node.path);
      case 'mongoDatabase':
        return await mongoCollectionChildren(this.mongoDeps(), node.connectionId, node.database);
      case 'mongoCollection':
        // A view has no indexes of its own: it reads another collection's.
        return node.collectionType === 'view'
          ? []
          : await mongoIndexChildren(this.mongoDeps(), node);
      case 'elasticIndex':
        return await elasticFieldChildren(this.elasticDeps(), node);
      case 'elasticField':
        return elasticSubfields(node);
      case 'column':
      case 'object':
      case 'index':
      case 'foreignKey':
      case 'savedQuery':
      case 'account':
      case 'redisKey':
      case 'redisMore':
      case 'mongoIndex':
      case 'message':
        return [];
    }
  }

  private elasticDeps(): ElasticTreeDeps {
    const { texts } = this.deps;
    return {
      manager: this.deps.manager,
      showSystemObjects: () => this.deps.settings.showSystemObjects(),
      texts: {
        noIndices: texts.noIndices ?? texts.noTables,
        noFields: texts.noFields ?? texts.noColumns,
      },
    };
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
      case 'queryFolder':
      case 'savedQuery':
      case 'security':
      case 'securityGroup':
      case 'account':
      case 'mongoDatabase':
      case 'mongoCollection':
      case 'mongoIndex':
      case 'elasticIndex':
      case 'elasticField':
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
    if (this.driverIdOf(connectionId) === 'mongodb') {
      return await mongoDatabaseChildren(this.mongoDeps(), this.configOf(connectionId));
    }
    if (this.driverIdOf(connectionId) === 'elasticsearch') {
      return await elasticIndexChildren(this.elasticDeps(), connectionId);
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
    const security: TreeNode[] =
      this.deps.accounts === undefined || !hasAccounts(this.driverIdOf(connectionId))
        ? []
        : [{ kind: 'security', connectionId }];
    return [...security, ...nodes, ...hidden];
  }

  private mongoDeps(): MongoTreeDeps {
    const { texts } = this.deps;
    return {
      manager: this.deps.manager,
      showSystemObjects: () => this.deps.settings.showSystemObjects(),
      texts: {
        noDatabases: texts.noDatabases,
        noCollections: texts.noCollections ?? texts.noTables,
        noIndexes: texts.empty.indexes,
        ...(texts.hiddenByFilter === undefined ? {} : { hiddenByFilter: texts.hiddenByFilter }),
      },
    };
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
    const queries = this.queryNode(connectionId, { database });
    const metadata = await this.metadataOf(connectionId, database);
    const all = await metadata.listSchemas(database);
    const unfiltered = this.deps.settings.showSystemObjects()
      ? all
      : withoutSystemSchemas(this.driverIdOf(connectionId), all);
    const schemas = filterNames(unfiltered, this.configOf(connectionId).filter?.schemas ?? []);
    return [
      ...queries,
      ...schemas.map((schema): TreeNode => ({ kind: 'schema', connectionId, database, schema })),
      ...this.hiddenLeaf(connectionId, unfiltered.length - schemas.length),
    ];
  }

  /** The "Query" folder of a scope, where saved queries are kept (V11.12). */
  private queryNode(connectionId: string, scope: ObjectScope): TreeNode[] {
    return this.deps.savedQueries === undefined
      ? []
      : [{ kind: 'queryFolder', connectionId, scope }];
  }

  private async queryChildren(
    node: Extract<TreeNode, { kind: 'queryFolder' }>,
  ): Promise<TreeNode[]> {
    const names = (await this.deps.savedQueries?.list(node.connectionId, node.scope)) ?? [];
    this.remember(node, names.length);
    if (names.length === 0) {
      return [
        {
          kind: 'message',
          text: this.deps.texts.noQueries ?? this.deps.texts.noTables,
          connectionId: node.connectionId,
        },
      ];
    }
    return names.map((name) => ({
      kind: 'savedQuery',
      connectionId: node.connectionId,
      scope: node.scope,
      name,
    }));
  }

  /** The accounts of a server, read once per opening of the Security folder (V11.12). */
  private async accountsOf(connectionId: string, fresh: boolean): Promise<readonly AccountInfo[]> {
    const known = fresh ? undefined : this.accountLists.get(connectionId);
    if (known !== undefined) {
      return known;
    }
    const listed = (await this.deps.accounts?.(connectionId)) ?? [];
    this.accountLists.set(connectionId, listed);
    return listed;
  }

  private async securityChildren(connectionId: string): Promise<TreeNode[]> {
    const accounts = await this.accountsOf(connectionId, true);
    const groups: SecurityGroupNode[] = (['users', 'roles'] as const).map((group) => ({
      kind: 'securityGroup',
      connectionId,
      group,
    }));
    for (const node of groups) {
      this.remember(
        node,
        accounts.filter((account) => inSecurityGroup(account, node.group)).length,
      );
    }
    return groups;
  }

  private async accountChildren(node: SecurityGroupNode): Promise<TreeNode[]> {
    const accounts = (await this.accountsOf(node.connectionId, false))
      .filter((account) => inSecurityGroup(account, node.group))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.remember(node, accounts.length);
    if (accounts.length === 0) {
      return [
        {
          kind: 'message',
          text: this.deps.texts.noAccounts?.(node.group) ?? '',
          connectionId: node.connectionId,
        },
      ];
    }
    return accounts.map((user) => ({
      kind: 'account',
      connectionId: node.connectionId,
      group: node.group,
      user,
    }));
  }

  /** Tables and views, then the folders of whatever else this database keeps. */
  private async groups(connectionId: string, scope: ObjectScope): Promise<TreeNode[]> {
    const { objectKinds } = await this.capabilitiesOf(connectionId);
    const groups: ObjectGroup[] = [
      'tables',
      'views',
      ...objectKinds.flatMap((kind) => (kind === 'trigger' ? [] : [GROUP_OF_KIND[kind]])),
    ];
    const nodes = groups.map((group): GroupNode => ({ kind: 'group', group, connectionId, scope }));
    await this.countGroups(nodes);
    return [...this.queryNode(connectionId, scope), ...nodes];
  }

  /** Fills in "Tables (40)" before the folders are drawn; the lists come from the cache. */
  private async countGroups(nodes: readonly GroupNode[]): Promise<void> {
    const [first] = nodes;
    if (first === undefined) {
      return;
    }
    const { connectionId, scope } = first;
    try {
      const metadata = await this.metadataOf(connectionId, scope.database);
      const listed = await metadata.listTables(scope);
      await Promise.all(
        nodes.map(async (node) => {
          if (node.group === 'tables' || node.group === 'views') {
            const wanted = node.group === 'tables' ? 'table' : 'view';
            this.remember(node, listed.filter((table) => table.kind === wanted).length);
            return;
          }
          const kind = KIND_OF_GROUP[node.group];
          this.remember(
            node,
            await this.tryCount(async () => (await metadata.listObjects(scope, kind)).length),
          );
        }),
      );
    } catch (error) {
      // The numbers only decorate the folders: without them they are listed all the same.
      this.logger.warn('Could not count the objects of a scope', error);
    }
  }

  /** The Filter… text of a Tables or Views folder, if it has one. */
  groupFilter(node: GroupNode): string | undefined {
    return this.groupFilters.get(nodeId(node));
  }

  /** Sets or (with undefined) clears the Filter… text of a folder. */
  setGroupFilter(node: GroupNode, text: string | undefined): void {
    const normalized = text === undefined ? undefined : normalizeTableFilter(text);
    if (normalized === undefined) {
      this.groupFilters.delete(nodeId(node));
    } else {
      this.groupFilters.set(nodeId(node), normalized);
    }
  }

  /** Statistics by table name; nothing when they are off, missing or fail to load. */
  private async statsOf(
    metadata: MetadataReader,
    scope: ObjectScope,
  ): Promise<ReadonlyMap<string, TableStats>> {
    if (this.deps.settings.tableStats?.() === false || metadata.tableStats === undefined) {
      return new Map();
    }
    try {
      const stats = await metadata.tableStats(scope);
      return new Map(stats.map((entry) => [entry.name, entry]));
    } catch (error) {
      // Statistics only decorate the list; a server that refuses them still lists tables.
      this.logger.warn('Could not read table statistics', error);
      return new Map();
    }
  }

  private async groupChildren(node: GroupNode): Promise<TreeNode[]> {
    const { connectionId, scope, group } = node;
    if (group !== 'tables' && group !== 'views') {
      const objects = await this.objectChildren(
        connectionId,
        scope,
        KIND_OF_GROUP[group],
        () => true,
        group,
      );
      this.remember(node, objects.filter((child) => child.kind === 'object').length);
      return objects;
    }
    const metadata = await this.metadataOf(connectionId, scope.database);
    const wanted = group === 'tables' ? 'table' : 'view';
    const [listed, stats] = await Promise.all([
      metadata.listTables(scope),
      this.statsOf(metadata, scope),
    ]);
    const all = listed.filter((table) => table.kind === wanted);
    const filter = this.groupFilter(node);
    const visible = filter === undefined ? undefined : tableFilter(filter);
    const found = visible === undefined ? all : all.filter((table) => visible(table.name));
    this.remember(node, found.length);
    if (all.length === 0) {
      return [
        {
          kind: 'message',
          text: group === 'tables' ? this.deps.texts.noTables : this.deps.texts.noViews,
          connectionId,
        },
      ];
    }
    return [
      ...found.map((table): TreeNode => {
        const known = stats.get(table.name);
        return {
          kind: 'table',
          connectionId,
          scope,
          name: table.name,
          tableKind: table.kind,
          ...(table.materialized === true ? { materialized: true } : {}),
          ...(known === undefined ? {} : { stats: known }),
        };
      }),
      ...this.hiddenLeaf(connectionId, all.length - found.length),
    ];
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

  /** A table lists its folders: Columns, then (for tables) Indexes, Foreign Keys, Triggers. */
  private async tableChildren(node: Extract<TreeNode, { kind: 'table' }>): Promise<TreeNode[]> {
    const table: TableRef = { ...node.scope, name: node.name };
    const folders: TableFolder[] =
      node.tableKind === 'table' ? ['columns', 'indexes', 'foreignKeys', 'triggers'] : ['columns'];
    const nodes = folders.map((folder) => ({
      kind: 'folder' as const,
      folder,
      connectionId: node.connectionId,
      table,
    }));
    const metadata = await this.metadataOf(node.connectionId, node.scope.database);
    await Promise.all(
      nodes.map(async (folder) => {
        this.remember(
          folder,
          await this.tryCount(async () => await this.folderSize(metadata, folder)),
        );
      }),
    );
    return nodes;
  }

  private async folderSize(metadata: MetadataReader, node: FolderNode): Promise<number> {
    const { table } = node;
    switch (node.folder) {
      case 'columns':
        return (await metadata.listColumns(table)).length;
      case 'indexes':
        return (await metadata.listIndexes(table)).length;
      case 'foreignKeys':
        return (await metadata.listForeignKeys(table)).length;
      case 'triggers':
        return (await metadata.listObjects(scopeOfTable(table), 'trigger')).filter(
          (object) => object.table === table.name,
        ).length;
    }
  }

  private async folderChildren(node: FolderNode): Promise<TreeNode[]> {
    const children = await this.folderContents(node);
    this.remember(node, children.filter((child) => child.kind !== 'message').length);
    return children;
  }

  private async folderContents(node: FolderNode): Promise<TreeNode[]> {
    const { connectionId, table } = node;
    const scope = scopeOfTable(table);
    const empty = (): TreeNode[] => [
      {
        kind: 'message',
        text:
          node.folder === 'columns'
            ? this.deps.texts.noColumns
            : this.deps.texts.empty[node.folder],
        connectionId,
      },
    ];
    const metadata = await this.metadataOf(connectionId, table.database);
    switch (node.folder) {
      case 'columns':
        return await this.columnChildren(node);
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

  private async columnChildren(node: FolderNode): Promise<TreeNode[]> {
    const { connectionId, table } = node;
    const metadata = await this.metadataOf(connectionId, table.database);
    const [columns, kind, linked] = await Promise.all([
      metadata.listColumns(table),
      this.relationKindOf(connectionId, table),
      this.linkedColumns(metadata, table),
    ]);
    if (columns.length === 0) {
      return [{ kind: 'message', text: this.deps.texts.noColumns, connectionId }];
    }
    const movable = kind === 'table' && canMoveColumns(this.driverIdOf(connectionId));
    return columns.map((column) => ({
      kind: 'column',
      connectionId,
      table,
      column,
      ...(movable ? { movable: true } : {}),
      ...(linked.has(column.name) ? { link: true } : {}),
    }));
  }

  /** Columns that belong to a foreign key; only decoration, so a failure shows none. */
  private async linkedColumns(metadata: MetadataReader, table: TableRef): Promise<Set<string>> {
    try {
      return new Set((await metadata.listForeignKeys(table)).flatMap((key) => key.columns));
    } catch (error) {
      this.logger.warn('Could not read the foreign keys of a table', error);
      return new Set();
    }
  }

  /** Tables can have their columns moved; views cannot. */
  private async relationKindOf(connectionId: string, table: TableRef): Promise<'table' | 'view'> {
    const metadata = await this.metadataOf(connectionId, table.database);
    const listed = await metadata.listTables(scopeOfTable(table));
    return listed.find((entry) => entry.name === table.name)?.kind === 'view' ? 'view' : 'table';
  }

  /** The driver of a saved connection; an unknown id cannot reach here. */
  private driverIdOf(connectionId: string): DriverId {
    return this.configOf(connectionId).driver;
  }

  private configOf(connectionId: string): ConnectionConfig {
    const config = this.deps.store.get(connectionId);
    if (!config) {
      throw new DbError('not-found', msg('Connection "{0}" does not exist', connectionId));
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

function scopeOfTable(table: TableRef): ObjectScope {
  return {
    ...(table.database === undefined ? {} : { database: table.database }),
    ...(table.schema === undefined ? {} : { schema: table.schema }),
  };
}

/** Users are the accounts that log in; Roles are everything that only groups privileges. */
export function inSecurityGroup(account: AccountInfo, group: SecurityGroup): boolean {
  const isRole = account.role || !account.login;
  return group === 'roles' ? isRole : !isRole;
}

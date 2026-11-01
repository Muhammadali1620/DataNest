import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import type { RedisKeyBrowser } from '../../services/redis/key-browser';
import { PROJECT_FILE_PATH } from '../../services/project-connections';
import type { VersionMemory } from '../../services/version-memory';
import {
  LabelCache,
  readServerVersion,
  readSizeBytes,
  shortSize,
} from '../../services/server-labels';
import {
  type ConnectionConfig,
  type DriverId,
  describeTarget,
  describeTunnel,
  driverFamily,
} from '../../shared/connection';
import { COMMAND_IDS, CONFIG_KEYS, CONFIG_SECTION } from '../command-ids';
import { affectsDataNest } from '../settings';
import { dbMarkFile } from '../../shared/db-marks';
import { connectionUri, tagText } from './connection-decorations';
import { redisTypeIcon } from './redis-type-icon';
import { tagsOf } from './connection-look';
import { elasticFieldItem, elasticIndexItem } from './elastic-items';
import { etcdFolderItem, etcdKeyItem, etcdMoreItem } from './etcd-items';
import {
  kafkaGroupItem,
  kafkaGroupsItem,
  kafkaPartitionItem,
  kafkaTopicItem,
  kafkaTopicsItem,
} from './kafka-items';
import type { EtcdKeyBrowser } from '../../services/etcd/key-browser';
import { mongoCollectionItem, mongoDatabaseItem, mongoIndexItem } from './mongo-items';
import {
  columnKind,
  describeAccount,
  describeColumn,
  describeForeignKey,
  describeIndex,
  objectLabel,
  type ColumnKind,
} from './node-text';
import {
  CONNECTIONS_VIEW_ID,
  connectionContext,
  connectionIdOf,
  nodeId,
  TREE_CONTEXT,
  type GroupNode,
  type ObjectGroup,
  type ObjectNode,
  type TableFolder,
  type TreeNode,
} from './nodes';
import {
  type FavoriteNode,
  type FavoritesRootNode,
  type FavoritesStore,
  type TreeElement,
  favoriteNodeId,
  nodeOfRef,
  starredContext,
} from './favorites';
import { starUri } from './connection-decorations';
import { type ProjectSource, TreeModel, type TreeModelDeps, type TreeSettings } from './tree-model';
import { formatCount } from '../../core/number-format';
import { folderCountView } from './folder-count';
import { countInFolder, folderBaseName } from '../../shared/folder-path';
import type { TableStats } from '../../core/model/objects';
import { formatSize } from '../../shared/byte-size';

export { CONNECTIONS_VIEW_ID, TREE_CONTEXT };

export interface ConnectionsTreeDeps {
  /** Where the extension's resources are; the tree's own table icons come from there. */
  readonly extensionUri?: vscode.Uri;
  readonly store: ConnectionStore;
  /** The loaded keys of Redis databases (V7.2). */
  readonly redisKeys?: RedisKeyBrowser;
  /** The folders of etcd connections as read so far (V13.19). */
  readonly etcdKeys?: EtcdKeyBrowser;
  /** `datanest.redis.keySeparator`. */
  readonly redisKeySeparator?: () => string;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly settings: TreeSettings;
  readonly logger: Logger;
  readonly projects?: ProjectSource;
  /** The last version seen behind each connection, shown while it is closed (V11.15). */
  readonly versionMemory?: VersionMemory;
  /** The accounts of a server, for the Security folder (V11.12). */
  readonly accounts?: TreeModelDeps['accounts'];
  /** The saved queries of a scope, for the Query folder (V11.12). */
  readonly savedQueries?: TreeModelDeps['savedQueries'];
  /** The starred nodes (V13.2). */
  readonly favorites?: FavoritesStore;
}

/** The one Favorites group; the editor finds an element again by this very object. */
const FAVORITES_ROOT: FavoritesRootNode = { kind: 'favorites' };

/** The Connections view: connections → databases/schemas → tables/views → columns. */
export class ConnectionsTreeProvider
  implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** The server version of each connected connection (V11.14); key: the connection id. */
  private readonly versions = new LabelCache<string>(
    (connectionId) => {
      // The editor finds the item to redraw by the very object `getChildren` returned.
      const node = this.connectionNodes.get(connectionId);
      if (node !== undefined) {
        this.changed.fire(node);
      }
    },
    (connectionId, error) => {
      this.deps.logger.debug(`Server version of ${connectionId} not read: ${errorMessage(error)}`);
    },
  );
  private readonly connectionNodes = new Map<string, TreeNode>();
  /** Sizes of databases and schemas; key: connection id, a NUL, the node id. */
  private readonly sizes = new LabelCache<number>((key) => {
    const node = this.sizeNodes.get(key);
    if (node !== undefined) {
      this.changed.fire(node);
    }
  });
  private readonly sizeNodes = new Map<string, TreeNode>();

  private readonly model: TreeModel;
  private readonly deps: ConnectionsTreeDeps;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(deps: ConnectionsTreeDeps) {
    this.deps = deps;
    this.model = new TreeModel({
      store: deps.store,
      ...(deps.projects === undefined ? {} : { projects: deps.projects }),
      manager: deps.manager,
      cache: deps.cache,
      ...(deps.redisKeys === undefined ? {} : { redisKeys: deps.redisKeys }),
      ...(deps.etcdKeys === undefined ? {} : { etcdKeys: deps.etcdKeys }),
      kafka: {
        showInternalTopics: () =>
          vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<boolean>(CONFIG_KEYS.kafkaShowInternalTopics, false),
        language: () => vscode.env.language,
        texts: {
          noTopics: vscode.l10n.t('No topics'),
          noGroups: vscode.l10n.t('No consumer groups'),
          noPartitions: vscode.l10n.t('No partitions'),
          noLag: vscode.l10n.t('The group has committed no offsets'),
          lagLine: (topic, partition, lag) =>
            vscode.l10n.t('{0} [{1}]: {2} behind', topic, partition, lag),
        },
      },
      ...(deps.redisKeySeparator === undefined
        ? {}
        : { redisKeySeparator: deps.redisKeySeparator }),
      ...(deps.accounts === undefined ? {} : { accounts: deps.accounts }),
      ...(deps.savedQueries === undefined ? {} : { savedQueries: deps.savedQueries }),
      settings: deps.settings,
      logger: deps.logger,
      texts: {
        noQueries: vscode.l10n.t('No saved queries'),
        noAccounts: (group) =>
          group === 'users' ? vscode.l10n.t('No users') : vscode.l10n.t('No roles'),
        project: {
          untrusted: (count) =>
            vscode.l10n.t(
              'Restricted Mode: trust this workspace to use its {0} connection(s)',
              count,
            ),
          broken: (error) => vscode.l10n.t('{0} cannot be read: {1}', PROJECT_FILE_PATH, error),
          skipped: (position, problem) =>
            vscode.l10n.t('Connection {0} of the file is skipped: {1}', position, problem),
          empty: vscode.l10n.t('No connections in the project file yet'),
        },
        tables: vscode.l10n.t('Tables'),
        views: vscode.l10n.t('Views'),
        noTables: vscode.l10n.t('No tables'),
        noViews: vscode.l10n.t('No views'),
        noDatabases: vscode.l10n.t('No databases'),
        noColumns: vscode.l10n.t('No columns'),
        noCollections: vscode.l10n.t('No collections'),
        noIndices: vscode.l10n.t('No indices'),
        noEtcdKeys: vscode.l10n.t('No keys'),
        noFields: vscode.l10n.t('No fields in the mapping'),
        noKeys: (pattern) =>
          pattern === undefined
            ? vscode.l10n.t('No keys')
            : vscode.l10n.t('No keys match {0}', pattern),
        redisKeys: (count) =>
          count === 1
            ? vscode.l10n.t('1 key')
            : vscode.l10n.t('{0} keys', formatCount(count, vscode.env.language)),
        hiddenByFilter: (count) => vscode.l10n.t('{0} more hidden by the filter', count),
        emptyFolder: vscode.l10n.t('Empty: drag connections here'),
        empty: {
          functions: vscode.l10n.t('No functions'),
          procedures: vscode.l10n.t('No procedures'),
          sequences: vscode.l10n.t('No sequences'),
          events: vscode.l10n.t('No events'),
          indexes: vscode.l10n.t('No indexes'),
          foreignKeys: vscode.l10n.t('No foreign keys'),
          triggers: vscode.l10n.t('No triggers'),
        },
      },
    });
    this.subscriptions.push(
      this.changed,
      deps.store.onDidChange(() => {
        // A deleted connection takes its stars with it.
        void deps.favorites
          ?.retainConnections(new Set(deps.store.list().map((config) => config.id)))
          .catch((error: unknown) => {
            deps.logger.warn('Could not drop the favorites of deleted connections', error);
          });
        this.refresh();
      }),
      ...(deps.favorites === undefined
        ? []
        : [
            deps.favorites.onDidChange(() => {
              this.refresh();
            }),
          ]),
      vscode.workspace.onDidChangeConfiguration((event) => {
        // Hiding system objects is a local filter: redrawing is enough.
        if (affectsDataNest(event)) {
          this.refresh();
        }
      }),
      deps.manager.onDidChangeState((connectionId) => {
        // A connection that dropped or reconnected may have a different structure.
        deps.cache.invalidate(connectionId);
        // Keys loaded over a link that is gone may be stale; a connect itself keeps
        // them, or the first expansion would load twice.
        const status = deps.manager.getState(connectionId).status;
        if (status === 'disconnected' || status === 'error') {
          deps.redisKeys?.reset(connectionId);
          deps.etcdKeys?.reset(connectionId);
        }
        // Status decorations live on connection items, which sit at the root.
        this.refresh();
      }),
    );
  }

  /** Reloads the whole tree, or the subtree of one node. */
  refresh(node?: TreeNode): void {
    // What was read about versions and sizes is read again once the tree is redrawn.
    if (node === undefined) {
      this.versions.clear();
      this.sizes.clear();
    } else if ('connectionId' in node) {
      this.sizes.clear(`${node.connectionId}\u0000`);
    }
    this.changed.fire(node);
    // A subtree also appears below the Favorites group, if it is starred.
    if (node !== undefined && this.deps.favorites?.list().length) {
      this.changed.fire(FAVORITES_ROOT);
    }
  }

  /** The Filter… text of a Tables or Views folder (V10.2.3). */
  groupFilter(node: GroupNode): string | undefined {
    return this.model.groupFilter(node);
  }

  /** Sets or clears the Filter… text of a folder and lists it again. */
  setGroupFilter(node: GroupNode, text: string | undefined): void {
    this.model.setGroupFilter(node, text);
    this.refresh(node);
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if (element.kind === 'favorites') {
      const item = new vscode.TreeItem(
        vscode.l10n.t('Favorites'),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = TREE_CONTEXT.favorites;
      item.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
      item.contextValue = TREE_CONTEXT.favorites;
      item.description = String(this.deps.favorites?.list().length ?? 0);
      item.tooltip = vscode.l10n.t('The nodes you starred, in the order you starred them');
      return item;
    }
    if (element.kind === 'favorite') {
      return this.favoriteItem(element);
    }
    return this.starred(element, this.nodeItem(element));
  }

  /** An entry of the Favorites group: the item of its node under an id of its own. */
  private favoriteItem(entry: FavoriteNode): vscode.TreeItem {
    // Entries are copies: the label caches must keep pointing at the real nodes.
    this.shadow = true;
    try {
      const item = this.starred(entry.target, this.nodeItem(entry.target));
      item.id = favoriteNodeId(entry);
      const owner = connectionIdOf(entry.target);
      if (entry.via === TREE_CONTEXT.favorites && entry.target.kind !== 'connection' && owner) {
        // Without the connection's name, two tables called "users" cannot be told apart.
        const name = this.deps.store.get(owner)?.name;
        if (name !== undefined) {
          item.description =
            typeof item.description === 'string' && item.description !== ''
              ? `${name} · ${item.description}`
              : name;
        }
      }
      return item;
    } finally {
      this.shadow = false;
    }
  }

  /** True while the item of a Favorites entry is built. */
  private shadow = false;

  /** Marks a starred node: a yellow star on its label, and the context of the menus. */
  private starred(node: TreeNode, item: vscode.TreeItem): vscode.TreeItem {
    if (this.deps.favorites?.has(node) !== true) {
      return item;
    }
    item.contextValue = starredContext(item.contextValue);
    // Connections already carry a look (ConnectionDecorations), which shows the star too.
    if (node.kind !== 'connection') {
      item.resourceUri = starUri(node);
    }
    return item;
  }

  private nodeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'project': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = nodeId(node);
        item.iconPath = new vscode.ThemeIcon('repo');
        item.description = PROJECT_FILE_PATH;
        item.tooltip = vscode.l10n.t(
          'Connections of the project "{0}" from {1}. The file can be committed: it holds no passwords, each person keeps theirs on their own computer.',
          node.name,
          PROJECT_FILE_PATH,
        );
        item.contextValue = TREE_CONTEXT.project;
        return item;
      }
      case 'connectionFolder': {
        // A nested folder shows its own name; the path is in the tooltip (V13.8).
        const item = new vscode.TreeItem(
          folderBaseName(node.folder),
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = nodeId(node);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = TREE_CONTEXT.connectionFolder;
        const inside = countInFolder(
          this.deps.store.list().map((config) => config.folder),
          node.folder,
        );
        item.description = inside === 0 ? undefined : String(inside);
        item.tooltip = node.folder.split('/').join(' › ');
        return item;
      }
      case 'connection':
        if (!this.shadow) {
          this.connectionNodes.set(node.connectionId, node);
        }
        return this.connectionItem(node.connectionId);
      case 'database': {
        const item = expandable(node, node.database, 'database', TREE_CONTEXT.database);
        item.description = this.sizeText(node);
        return item;
      }
      case 'schema': {
        const item = expandable(node, node.schema, 'symbol-namespace', TREE_CONTEXT.schema);
        item.description = this.sizeText(node);
        return item;
      }
      case 'group': {
        const item = expandable(
          node,
          groupLabel(node.group),
          GROUP_ICONS[node.group],
          node.group === 'tables'
            ? TREE_CONTEXT.tablesGroup
            : node.group === 'views'
              ? TREE_CONTEXT.viewsGroup
              : TREE_CONTEXT.group,
        );
        const filter = this.model.groupFilter(node);
        item.description = withCount(
          this.model.countOf(node),
          filter === undefined ? undefined : vscode.l10n.t('filter: {0}', filter),
        );
        return item;
      }
      case 'folder': {
        const item = expandable(
          node,
          folderLabel(node.folder),
          FOLDER_ICONS[node.folder],
          TREE_CONTEXT.folder,
        );
        // The columns open with the table; the other folders wait for their arrow.
        if (node.folder === 'columns') {
          item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }
        item.description = withCount(this.model.countOf(node));
        return item;
      }
      case 'queryFolder': {
        const item = expandable(node, vscode.l10n.t('Query'), 'notebook', TREE_CONTEXT.queryFolder);
        item.description = withCount(this.model.countOf(node));
        return item;
      }
      case 'savedQuery': {
        const item = leaf(node, node.name, 'file-code');
        item.contextValue = TREE_CONTEXT.savedQuery;
        item.tooltip = vscode.l10n.t('Saved query "{0}"', node.name);
        item.command = {
          command: COMMAND_IDS.openSavedQuery,
          title: vscode.l10n.t('Open Query'),
          arguments: [node],
        };
        return item;
      }
      case 'security':
        return expandable(node, vscode.l10n.t('Security'), 'shield', TREE_CONTEXT.security);
      case 'securityGroup': {
        const item = expandable(
          node,
          node.group === 'users' ? vscode.l10n.t('Users') : vscode.l10n.t('Roles'),
          node.group === 'users' ? 'account' : 'organization',
          TREE_CONTEXT.securityGroup,
        );
        item.description = withCount(this.model.countOf(node));
        return item;
      }
      case 'account': {
        const item = leaf(
          node,
          accountLabel(node.user),
          node.user.role || !node.user.login ? 'organization' : 'person',
        );
        item.description = describeAccount(node.user);
        item.tooltip = `${accountLabel(node.user)} — ${describeAccount(node.user)}`;
        item.contextValue =
          node.user.role || !node.user.login ? TREE_CONTEXT.role : TREE_CONTEXT.account;
        item.command = {
          command: COMMAND_IDS.openAccount,
          title: vscode.l10n.t('Open in Users and Privileges'),
          arguments: [node],
        };
        return item;
      }
      case 'object':
        return objectItem(node);
      case 'index': {
        const item = leaf(node, node.index.name, node.index.primary ? 'key' : 'list-ordered');
        item.description = describeIndex(node.index);
        item.tooltip = `${node.index.name} — ${describeIndex(node.index)}`;
        item.contextValue = TREE_CONTEXT.index;
        item.command = nodeClickCommand(node);
        return item;
      }
      case 'foreignKey': {
        const item = leaf(node, node.key.name, 'references');
        item.description = describeForeignKey(node.key);
        item.tooltip = `${node.key.name} — ${describeForeignKey(node.key)}`;
        item.contextValue = TREE_CONTEXT.foreignKey;
        item.command = nodeClickCommand(node);
        return item;
      }
      case 'table': {
        const item = expandable(
          node,
          node.name,
          node.tableKind === 'view' ? 'eye' : 'table',
          node.tableKind === 'view' ? TREE_CONTEXT.view : TREE_CONTEXT.table,
        );
        if (this.deps.extensionUri !== undefined) {
          item.iconPath = vscode.Uri.joinPath(
            this.deps.extensionUri,
            'resources',
            'icons',
            'tree',
            node.tableKind === 'view' ? 'view.svg' : 'table.svg',
          );
        }
        item.tooltip = tableTooltip(qualifiedName(node.scope, node.name), node.stats);
        // A double click opens the table's rows; the first click only expands the row.
        item.command = {
          command: COMMAND_IDS.clickTable,
          title: vscode.l10n.t('Open Table'),
          arguments: [node],
        };
        if (node.stats?.rows !== undefined && node.tableKind === 'table') {
          item.description = vscode.l10n.t(
            '≈ {0} rows',
            formatCount(node.stats.rows, vscode.env.language),
          );
        }
        return item;
      }
      case 'column': {
        const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
        item.id = nodeId(node);
        item.description = describeColumn(node.column);
        item.tooltip = `${node.column.name} — ${describeColumn(node.column)}`;
        item.iconPath = columnIcon(
          node.column.primaryKey,
          node.link === true,
          columnKind(node.column.dataType),
        );
        item.contextValue =
          node.movable === true ? TREE_CONTEXT.columnMovable : TREE_CONTEXT.column;
        item.command = nodeClickCommand(node);
        return item;
      }
      case 'redisDatabase': {
        const item = new vscode.TreeItem(
          `db${node.database}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = nodeId(node);
        item.iconPath = coloredIcon('database');
        item.contextValue = TREE_CONTEXT.redisDatabase;
        const pattern = this.deps.redisKeys?.patternOf(node.connectionId, node.database);
        const count = this.model.redisKeysText(node.keys);
        item.description = pattern === undefined ? count : `${count} · ${pattern}`;
        item.tooltip =
          pattern === undefined ? undefined : vscode.l10n.t('Only keys that match {0}', pattern);
        return item;
      }
      case 'redisFolder': {
        // An empty segment (`a::b`) would leave the item without a label.
        const name = node.path.at(-1) ?? '';
        const item = new vscode.TreeItem(
          name === '' ? '""' : name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = nodeId(node);
        item.iconPath = vscode.ThemeIcon.Folder;
        const total = this.deps.redisKeys?.countOf(node.connectionId, node.database, node.prefix);
        const view = folderCountView(node.count, total, (count) =>
          formatCount(count, vscode.env.language),
        );
        item.description = view.text;
        item.tooltip =
          view.kind === 'counted'
            ? view.exact
              ? vscode.l10n.t('{0} keys under {1}', view.count, node.prefix)
              : vscode.l10n.t(
                  'At least {0} keys under {1}: counting stopped at its limit',
                  view.count,
                  node.prefix,
                )
            : view.kind === 'counting'
              ? vscode.l10n.t('Counting keys under {0}: {1} so far', node.prefix, view.found)
              : vscode.l10n.t('{0} keys loaded under {1}', node.count, node.prefix);
        item.contextValue = TREE_CONTEXT.redisFolder;
        return item;
      }
      case 'redisKey': {
        const item = new vscode.TreeItem(
          node.name === '' ? node.key.text : node.name,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = nodeId(node);
        const look = redisTypeIcon(node.keyType);
        item.iconPath = new vscode.ThemeIcon(
          look.icon,
          look.color === undefined ? undefined : new vscode.ThemeColor(look.color),
        );
        item.description = node.keyType;
        item.tooltip = node.key.text;
        item.contextValue = TREE_CONTEXT.redisKey;
        item.command = {
          command: 'datanest.redis.openKey',
          title: vscode.l10n.t('Open Key'),
          arguments: [node],
        };
        return item;
      }
      case 'redisMore': {
        const item = new vscode.TreeItem(
          vscode.l10n.t('Load more keys…'),
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = nodeId(node);
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.description = vscode.l10n.t(
          '{0} loaded',
          formatCount(node.loaded, vscode.env.language),
        );
        item.contextValue = TREE_CONTEXT.redisMore;
        item.command = {
          command: 'datanest.redis.loadMoreKeys',
          title: vscode.l10n.t('Load more keys'),
          arguments: [node],
        };
        return item;
      }
      case 'mongoDatabase':
        return mongoDatabaseItem(node);
      case 'mongoCollection':
        return mongoCollectionItem(node);
      case 'mongoIndex':
        return mongoIndexItem(node);
      case 'elasticIndex':
        return elasticIndexItem(node);
      case 'elasticField':
        return elasticFieldItem(node);
      case 'etcdFolder':
        return etcdFolderItem(node);
      case 'etcdKey':
        return etcdKeyItem(node);
      case 'etcdMore':
        return etcdMoreItem(node);
      case 'kafkaTopics':
        return kafkaTopicsItem(node);
      case 'kafkaTopic':
        return kafkaTopicItem(node);
      case 'kafkaPartition':
        return kafkaPartitionItem(node);
      case 'kafkaGroups':
        return kafkaGroupsItem(node);
      case 'kafkaGroup':
        return kafkaGroupItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = nodeId(node);
        item.contextValue = TREE_CONTEXT.message;
        if (node.failed) {
          item.iconPath = new vscode.ThemeIcon(
            'error',
            new vscode.ThemeColor('list.errorForeground'),
          );
        }
        return item;
      }
    }
  }

  /**
   * Holds the children of a table back while a click on its label may be the first of a
   * double click (set by the commands, which own the click bookkeeping).
   */
  holdChildren: ((node: TreeNode) => Promise<void>) | undefined;

  async getChildren(element?: TreeElement): Promise<TreeElement[]> {
    if (element === undefined) {
      const roots = this.model.roots();
      return this.deps.favorites?.list().length ? [FAVORITES_ROOT, ...roots] : roots;
    }
    if (element.kind === 'favorites') {
      return (this.deps.favorites?.list() ?? [])
        .filter((ref) => this.deps.store.get(ref.connectionId) !== undefined)
        .map((ref): FavoriteNode => ({
          kind: 'favorite',
          target: nodeOfRef(ref),
          via: TREE_CONTEXT.favorites,
        }));
    }
    if (element.kind === 'favorite') {
      const children = await this.getChildren(element.target);
      return (children as TreeNode[]).map((target): FavoriteNode => ({
        kind: 'favorite',
        target,
        via: favoriteNodeId(element),
      }));
    }
    const node = element;
    if (node.kind === 'table') {
      await this.holdChildren?.(node);
    }
    return await this.model.children(node);
  }

  /** Lets a found Redis key be revealed (V7.2). */
  getParent(element: TreeElement): TreeNode | undefined {
    return element.kind === 'favorites' || element.kind === 'favorite'
      ? undefined
      : this.model.parentOf(element);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  /**
   * The version of the server behind a connection. A connected one is read once in the
   * background (and remembered); a closed one shows the version seen last time.
   */
  private versionText(
    connectionId: string,
    config: ConnectionConfig | undefined,
    connected: boolean,
  ): string | undefined {
    if (config === undefined) {
      return undefined;
    }
    const remembered = this.deps.versionMemory?.recall(connectionId, config);
    if (!connected) {
      return remembered;
    }
    this.versions.ask(connectionId, async () => {
      return await readServerVersion(this.deps.manager, connectionId, config.driver);
    });
    const live = this.versions.peek(connectionId);
    if (live !== undefined && live !== remembered) {
      void this.deps.versionMemory?.remember(connectionId, config, live);
    }
    return live ?? remembered;
  }

  /** The size of a database or schema node, read once in the background; `2.4M`. */
  private sizeText(node: Extract<TreeNode, { kind: 'database' | 'schema' }>): string | undefined {
    const driver = this.deps.store.get(node.connectionId)?.driver;
    if (
      driver === undefined ||
      !connectedNow(this.deps.manager.getState(node.connectionId).status) ||
      this.deps.settings.showSizes?.() === false
    ) {
      return undefined;
    }
    const key = `${node.connectionId}\u0000${nodeId(node)}`;
    if (!this.shadow) {
      this.sizeNodes.set(key, node);
    }
    this.sizes.ask(key, async () => {
      // A MySQL "database" is its schema; the others name a schema inside a database.
      const target =
        node.kind === 'database'
          ? { database: node.database }
          : { database: node.database, schema: node.schema };
      return await readSizeBytes(this.deps.manager, node.connectionId, driver, target);
    });
    const bytes = this.sizes.peek(key);
    return bytes === undefined ? undefined : shortSize(bytes);
  }

  private connectionItem(connectionId: string): vscode.TreeItem {
    const config = this.deps.store.get(connectionId);
    const state = this.deps.manager.getState(connectionId);
    const item = new vscode.TreeItem(
      config?.name ?? connectionId,
      config?.disabled === true
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = nodeId({ kind: 'connection', connectionId });
    // Carries the color label (ConnectionDecorations); the icon stays the status.
    item.resourceUri = connectionUri(connectionId);
    const tags = tagsOf(config).map(tagText);
    const target = config === undefined ? '' : describeTarget(config);
    // The marks come first, so they stay visible when the description is cut.
    const version = this.versionText(connectionId, config, connectedNow(state.status));
    const rest = tags.length === 0 ? target : `${tags.join(' · ')} · ${target}`;
    item.description = version === undefined ? rest : `${version} · ${rest}`;
    const project = this.deps.store.projectOf(connectionId);
    const connected = state.status === 'connected';
    if (config?.disabled === true) {
      item.contextValue = TREE_CONTEXT.connectionDisabled;
      item.tooltip = new vscode.MarkdownString(
        `**${config.name}**\n\n${describeTarget(config)}\n\n${vscode.l10n.t('Disabled: it is kept, but never connected to')}`,
      );
      item.iconPath = new vscode.ThemeIcon(
        'circle-slash',
        new vscode.ThemeColor('disabledForeground'),
      );
      return item;
    }
    item.contextValue = connectionContext({
      project: project !== undefined,
      connected,
      family: config === undefined ? 'sql' : driverFamily(config.driver),
    });
    item.tooltip = new vscode.MarkdownString(
      [
        `**${config?.name ?? connectionId}**`,
        config === undefined ? '' : `\n\n${describeTarget(config)}`,
        version === undefined ? '' : `\n\n${vscode.l10n.t('Server version {0}', version)}`,
        tunnelLine(config),
        filterLine(config),
        project === undefined
          ? ''
          : `\n\n${vscode.l10n.t('Shared with the project "{0}" through {1}', project.name, PROJECT_FILE_PATH)}`,
        `\n\n${statusText(state.status)}`,
        state.error === undefined ? '' : `\n\n${state.error}`,
      ].join(''),
    );
    item.iconPath = connectionIcon(this.deps.extensionUri, config?.driver, state.status);
    return item;
  }
}

/** The filter of a connection, so a missing database has an explanation at hand. */
function filterLine(config: ConnectionConfig | undefined): string {
  // As code, so `app_*` stays a pattern and does not turn into Markdown emphasis.
  const code = (patterns: readonly string[]): string =>
    patterns.map((pattern) => `\`${pattern.replaceAll('`', '')}\``).join(', ');
  const lines = [
    config?.filter?.databases === undefined
      ? ''
      : `\n\n${vscode.l10n.t('Databases: {0}', code(config.filter.databases))}`,
    config?.filter?.schemas === undefined
      ? ''
      : `\n\n${vscode.l10n.t('Schemas: {0}', code(config.filter.schemas))}`,
  ];
  return lines.join('');
}

function tunnelLine(config: Parameters<typeof describeTunnel>[0] | undefined): string {
  const tunnel = config === undefined ? undefined : describeTunnel(config);
  return tunnel === undefined ? '' : `\n\n${vscode.l10n.t('Through SSH: {0}', tunnel)}`;
}

function statusText(status: ReturnType<ConnectionManager['getState']>['status']): string {
  switch (status) {
    case 'connected':
      return vscode.l10n.t('Connected');
    case 'connecting':
      return vscode.l10n.t('Connecting…');
    case 'error':
      return vscode.l10n.t('Connection failed');
    case 'disconnected':
      return vscode.l10n.t('Not connected');
  }
}

/**
 * The database's own mark (D113): dimmed while not connected, with a green dot when
 * connected and a red one after a failure; a spinner while connecting. Without the
 * extension folder or a known driver the status is a plain database icon.
 */
function connectionIcon(
  extensionUri: vscode.Uri | undefined,
  driver: DriverId | undefined,
  status: ReturnType<ConnectionManager['getState']>['status'],
): vscode.Uri | vscode.ThemeIcon {
  if (status === 'connecting' || extensionUri === undefined || driver === undefined) {
    return statusIcon(status);
  }
  const state = status === 'connected' ? 'on' : status === 'error' ? 'error' : 'off';
  return vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'db', dbMarkFile(driver, state));
}

function statusIcon(status: ReturnType<ConnectionManager['getState']>['status']): vscode.ThemeIcon {
  switch (status) {
    case 'connected':
      return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'));
    case 'connecting':
      return new vscode.ThemeIcon('loading~spin');
    case 'error':
      return new vscode.ThemeIcon('database', new vscode.ThemeColor('list.errorForeground'));
    case 'disconnected':
      return new vscode.ThemeIcon('database');
  }
}

function expandable(
  node: TreeNode,
  label: string,
  icon: string,
  contextValue: string,
): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = nodeId(node);
  item.iconPath = coloredIcon(icon);
  item.contextValue = contextValue;
  return item;
}

/** Each kind of object has its own colour, so the tree reads by colour before text. */
const ICON_COLORS: Readonly<Record<string, string>> = {
  table: 'charts.blue',
  'list-flat': 'charts.blue',
  eye: 'charts.purple',
  database: 'charts.orange',
  key: 'charts.yellow',
  'symbol-field': 'charts.foreground',
  'list-ordered': 'charts.green',
  references: 'terminal.ansiMagenta',
  zap: 'charts.yellow',
  'symbol-function': 'terminal.ansiCyan',
  'symbol-method': 'terminal.ansiCyan',
  'symbol-number': 'charts.green',
  calendar: 'charts.red',
  notebook: 'charts.yellow',
  'file-code': 'charts.yellow',
  shield: 'charts.red',
  account: 'charts.blue',
  organization: 'charts.purple',
};

function coloredIcon(icon: string): vscode.ThemeIcon {
  const color = ICON_COLORS[icon];
  return color === undefined
    ? new vscode.ThemeIcon(icon)
    : new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
}

const GROUP_ICONS: Readonly<Record<ObjectGroup, string>> = {
  tables: 'list-flat',
  views: 'eye',
  functions: 'symbol-function',
  procedures: 'symbol-method',
  sequences: 'symbol-number',
  events: 'calendar',
};

const FOLDER_ICONS: Readonly<Record<TableFolder, string>> = {
  columns: 'symbol-field',
  indexes: 'list-ordered',
  foreignKeys: 'references',
  triggers: 'zap',
};

const OBJECT_ICONS: Readonly<Record<ObjectNode['object']['kind'], string>> = {
  function: 'symbol-function',
  procedure: 'symbol-method',
  trigger: 'zap',
  sequence: 'symbol-number',
  event: 'calendar',
};

function groupLabel(group: ObjectGroup): string {
  switch (group) {
    case 'tables':
      return vscode.l10n.t('Tables');
    case 'views':
      return vscode.l10n.t('Views');
    case 'functions':
      return vscode.l10n.t('Functions');
    case 'procedures':
      return vscode.l10n.t('Procedures');
    case 'sequences':
      return vscode.l10n.t('Sequences');
    case 'events':
      return vscode.l10n.t('Events');
  }
}

function folderLabel(folder: TableFolder): string {
  switch (folder) {
    case 'columns':
      return vscode.l10n.t('Columns');
    case 'indexes':
      return vscode.l10n.t('Indexes');
    case 'foreignKeys':
      return vscode.l10n.t('Foreign Keys');
    case 'triggers':
      return vscode.l10n.t('Triggers');
  }
}

function objectItem(node: ObjectNode): vscode.TreeItem {
  const { object } = node;
  const item = leaf(node, objectLabel(object), OBJECT_ICONS[object.kind]);
  item.tooltip = qualifiedName(object, objectLabel(object));
  item.contextValue = TREE_CONTEXT[object.kind];
  item.command = nodeClickCommand(node);
  return item;
}

/** What a click on a column, index, key or routine runs: the second click opens its SQL. */
function nodeClickCommand(node: TreeNode): vscode.Command {
  return {
    command: COMMAND_IDS.clickNode,
    title: vscode.l10n.t('Open SQL'),
    arguments: [node],
  };
}

/** `(40)` after a folder's name, with a note (a filter) behind it when there is one. */
function withCount(count: number | undefined, note?: string): string | undefined {
  const parts = [count === undefined ? undefined : `(${count})`, note].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(' ');
}

function accountLabel(user: { name: string; host?: string }): string {
  return user.host === undefined ? user.name : `${user.name}@${user.host}`;
}

/** Key, link, then the kind of the type: every column kind has its own shape and colour. */
function columnIcon(primary: boolean, link: boolean, kind: ColumnKind): vscode.ThemeIcon {
  if (primary) {
    return new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow'));
  }
  if (link) {
    return new vscode.ThemeIcon('references', new vscode.ThemeColor('terminal.ansiMagenta'));
  }
  const [icon, color] = COLUMN_KIND_ICONS[kind];
  return new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
}

const COLUMN_KIND_ICONS: Readonly<Record<ColumnKind, readonly [string, string]>> = {
  number: ['symbol-number', 'charts.green'],
  text: ['symbol-string', 'charts.orange'],
  datetime: ['calendar', 'charts.red'],
  boolean: ['symbol-boolean', 'charts.purple'],
  json: ['json', 'terminal.ansiCyan'],
  binary: ['file-binary', 'descriptionForeground'],
  uuid: ['fingerprint', 'charts.blue'],
  choice: ['list-selection', 'charts.purple'],
  geometry: ['globe', 'charts.green'],
  other: ['symbol-field', 'charts.foreground'],
};

function leaf(node: TreeNode, label: string, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = nodeId(node);
  item.iconPath = coloredIcon(icon);
  return item;
}

/** The table's full name, then what the server's statistics say about it. */
function tableTooltip(name: string, stats: TableStats | undefined): string {
  const lines = [name];
  if (stats?.rows !== undefined) {
    lines.push(vscode.l10n.t('Rows (estimate): {0}', formatCount(stats.rows, vscode.env.language)));
  }
  if (stats?.bytes !== undefined) {
    lines.push(vscode.l10n.t('Size: {0}', formatSize(stats.bytes)));
  }
  if (stats?.comment !== undefined) {
    lines.push('', stats.comment);
  }
  return lines.join('\n');
}

function qualifiedName(scope: { database?: string; schema?: string }, name: string): string {
  return [scope.database, scope.schema, name].filter((part) => part !== undefined).join('.');
}

function connectedNow(status: string): boolean {
  return status === 'connected';
}

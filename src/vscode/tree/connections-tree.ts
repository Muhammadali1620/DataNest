import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import type { RedisKeyBrowser } from '../../services/redis/key-browser';
import { PROJECT_FILE_PATH } from '../../services/project-connections';
import {
  type ConnectionConfig,
  describeTarget,
  describeTunnel,
  driverFamily,
} from '../../shared/connection';
import { affectsDataNest } from '../settings';
import { connectionUri, tagText } from './connection-decorations';
import { tagsOf } from './connection-look';
import { elasticFieldItem, elasticIndexItem } from './elastic-items';
import { mongoCollectionItem, mongoDatabaseItem, mongoIndexItem } from './mongo-items';
import { describeColumn, describeForeignKey, describeIndex, objectLabel } from './node-text';
import {
  CONNECTIONS_VIEW_ID,
  connectionContext,
  nodeId,
  TREE_CONTEXT,
  type ObjectGroup,
  type ObjectNode,
  type TableFolder,
  type TreeNode,
} from './nodes';
import { type ProjectSource, TreeModel, type TreeSettings } from './tree-model';

export { CONNECTIONS_VIEW_ID, TREE_CONTEXT };

export interface ConnectionsTreeDeps {
  readonly store: ConnectionStore;
  /** The loaded keys of Redis databases (V7.2). */
  readonly redisKeys?: RedisKeyBrowser;
  /** `datanest.redis.keySeparator`. */
  readonly redisKeySeparator?: () => string;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly settings: TreeSettings;
  readonly logger: Logger;
  readonly projects?: ProjectSource;
}

/** The Connections view: connections → databases/schemas → tables/views → columns. */
export class ConnectionsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

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
      ...(deps.redisKeySeparator === undefined
        ? {}
        : { redisKeySeparator: deps.redisKeySeparator }),
      settings: deps.settings,
      logger: deps.logger,
      texts: {
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
        noFields: vscode.l10n.t('No fields in the mapping'),
        noKeys: (pattern) =>
          pattern === undefined
            ? vscode.l10n.t('No keys')
            : vscode.l10n.t('No keys match {0}', pattern),
        redisKeys: (count) =>
          count === 1 ? vscode.l10n.t('1 key') : vscode.l10n.t('{0} keys', count.toLocaleString()),
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
        this.refresh();
      }),
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
        }
        // Status decorations live on connection items, which sit at the root.
        this.refresh();
      }),
    );
  }

  /** Reloads the whole tree, or the subtree of one node. */
  refresh(node?: TreeNode): void {
    this.changed.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
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
        const item = new vscode.TreeItem(node.folder, vscode.TreeItemCollapsibleState.Expanded);
        item.id = nodeId(node);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = TREE_CONTEXT.connectionFolder;
        return item;
      }
      case 'connection':
        return this.connectionItem(node.connectionId);
      case 'database':
        return expandable(node, node.database, 'database', TREE_CONTEXT.database);
      case 'schema':
        return expandable(node, node.schema, 'symbol-namespace', TREE_CONTEXT.schema);
      case 'group':
        return expandable(
          node,
          groupLabel(node.group),
          GROUP_ICONS[node.group],
          node.group === 'tables'
            ? TREE_CONTEXT.tablesGroup
            : node.group === 'views'
              ? TREE_CONTEXT.viewsGroup
              : TREE_CONTEXT.group,
        );
      case 'folder':
        return expandable(
          node,
          folderLabel(node.folder),
          FOLDER_ICONS[node.folder],
          TREE_CONTEXT.folder,
        );
      case 'object':
        return objectItem(node);
      case 'index': {
        const item = leaf(node, node.index.name, node.index.primary ? 'key' : 'list-ordered');
        item.description = describeIndex(node.index);
        item.tooltip = `${node.index.name} — ${describeIndex(node.index)}`;
        item.contextValue = TREE_CONTEXT.index;
        return item;
      }
      case 'foreignKey': {
        const item = leaf(node, node.key.name, 'references');
        item.description = describeForeignKey(node.key);
        item.tooltip = `${node.key.name} — ${describeForeignKey(node.key)}`;
        item.contextValue = TREE_CONTEXT.foreignKey;
        return item;
      }
      case 'table': {
        const item = expandable(
          node,
          node.name,
          node.tableKind === 'view' ? 'eye' : 'table',
          node.tableKind === 'view' ? TREE_CONTEXT.view : TREE_CONTEXT.table,
        );
        item.tooltip = qualifiedName(node.scope, node.name);
        return item;
      }
      case 'column': {
        const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
        item.id = nodeId(node);
        item.description = describeColumn(node.column);
        item.tooltip = `${node.column.name} — ${describeColumn(node.column)}`;
        item.iconPath = new vscode.ThemeIcon(node.column.primaryKey ? 'key' : 'symbol-field');
        item.contextValue = TREE_CONTEXT.column;
        return item;
      }
      case 'redisDatabase': {
        const item = new vscode.TreeItem(
          `db${node.database}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = nodeId(node);
        item.iconPath = new vscode.ThemeIcon('database');
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
        item.description = node.count.toLocaleString();
        item.tooltip = vscode.l10n.t('{0} keys loaded under {1}', node.count, node.prefix);
        item.contextValue = TREE_CONTEXT.redisFolder;
        return item;
      }
      case 'redisKey': {
        const item = new vscode.TreeItem(
          node.name === '' ? node.key.text : node.name,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = nodeId(node);
        item.iconPath = new vscode.ThemeIcon(redisTypeIcon(node.keyType));
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
        item.description = vscode.l10n.t('{0} loaded', node.loaded.toLocaleString());
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

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    return node === undefined ? this.model.roots() : await this.model.children(node);
  }

  /** Lets a found Redis key be revealed (V7.2). */
  getParent(node: TreeNode): TreeNode | undefined {
    return this.model.parentOf(node);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  private connectionItem(connectionId: string): vscode.TreeItem {
    const config = this.deps.store.get(connectionId);
    const state = this.deps.manager.getState(connectionId);
    const item = new vscode.TreeItem(
      config?.name ?? connectionId,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = nodeId({ kind: 'connection', connectionId });
    // Carries the color label (ConnectionDecorations); the icon stays the status.
    item.resourceUri = connectionUri(connectionId);
    const tags = tagsOf(config).map(tagText);
    const target = config === undefined ? '' : describeTarget(config);
    // The marks come first, so they stay visible when the description is cut.
    item.description = tags.length === 0 ? target : `${tags.join(' · ')} · ${target}`;
    const project = this.deps.store.projectOf(connectionId);
    const connected = state.status === 'connected';
    item.contextValue = connectionContext({
      project: project !== undefined,
      connected,
      family: config === undefined ? 'sql' : driverFamily(config.driver),
    });
    item.tooltip = new vscode.MarkdownString(
      [
        `**${config?.name ?? connectionId}**`,
        config === undefined ? '' : `\n\n${describeTarget(config)}`,
        tunnelLine(config),
        filterLine(config),
        project === undefined
          ? ''
          : `\n\n${vscode.l10n.t('Shared with the project "{0}" through {1}', project.name, PROJECT_FILE_PATH)}`,
        `\n\n${statusText(state.status)}`,
        state.error === undefined ? '' : `\n\n${state.error}`,
      ].join(''),
    );
    item.iconPath = connectionIcon(state.status);
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

function connectionIcon(
  status: ReturnType<ConnectionManager['getState']>['status'],
): vscode.ThemeIcon {
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

/** Codicons per Redis type; a module's own type (JSON, time series) gets a generic one. */
function redisTypeIcon(type: string | undefined): string {
  switch (type) {
    case 'string':
      return 'symbol-string';
    case 'hash':
      return 'symbol-structure';
    case 'list':
      return 'list-ordered';
    case 'set':
      return 'symbol-array';
    case 'zset':
      return 'list-filter';
    case 'stream':
      return 'pulse';
    case undefined:
      return 'key';
    default:
      return 'extensions';
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
  item.iconPath = new vscode.ThemeIcon(icon);
  item.contextValue = contextValue;
  return item;
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
  return item;
}

function leaf(node: TreeNode, label: string, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function qualifiedName(scope: { database?: string; schema?: string }, name: string): string {
  return [scope.database, scope.schema, name].filter((part) => part !== undefined).join('.');
}

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import { describeTarget, describeTunnel } from '../../shared/connection';
import { affectsDataNest } from '../settings';
import { describeColumn, describeForeignKey, describeIndex, objectLabel } from './node-text';
import {
  CONNECTIONS_VIEW_ID,
  nodeId,
  TREE_CONTEXT,
  type ObjectGroup,
  type ObjectNode,
  type TableFolder,
  type TreeNode,
} from './nodes';
import { TreeModel, type TreeSettings } from './tree-model';

export { CONNECTIONS_VIEW_ID, TREE_CONTEXT };

export interface ConnectionsTreeDeps {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly settings: TreeSettings;
  readonly logger: Logger;
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
      manager: deps.manager,
      cache: deps.cache,
      settings: deps.settings,
      logger: deps.logger,
      texts: {
        tables: vscode.l10n.t('Tables'),
        views: vscode.l10n.t('Views'),
        noTables: vscode.l10n.t('No tables'),
        noViews: vscode.l10n.t('No views'),
        noDatabases: vscode.l10n.t('No databases'),
        noColumns: vscode.l10n.t('No columns'),
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
          TREE_CONTEXT.group,
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
    item.description = config === undefined ? '' : describeTarget(config);
    item.contextValue =
      state.status === 'connected' ? TREE_CONTEXT.connectionConnected : TREE_CONTEXT.connection;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${config?.name ?? connectionId}**`,
        config === undefined ? '' : `\n\n${describeTarget(config)}`,
        tunnelLine(config),
        `\n\n${statusText(state.status)}`,
        state.error === undefined ? '' : `\n\n${state.error}`,
      ].join(''),
    );
    item.iconPath = connectionIcon(state.status);
    return item;
  }
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

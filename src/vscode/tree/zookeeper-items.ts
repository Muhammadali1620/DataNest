// How ZooKeeper nodes look in the tree (V13.24): znodes with the number of children they have
// (a znode holds data and children alike, so it opens on a click and expands on an arrow),
// marked by what they are — ephemeral (a clock), container (a package), ordinary — and
// "load more".

import * as vscode from 'vscode';
import { formatCount } from '../../core/number-format';
import { isSequentialName, ROOT_PATH, type ZnodeKind } from '../../shared/zk-path';
import { nodeId, TREE_CONTEXT, type ZookeeperMoreNode, type ZookeeperNodeNode } from './nodes';

/** The icon of a znode by its kind: colour tells what it is. */
export function zookeeperIcon(
  kind: ZnodeKind | undefined,
  hasChildren: boolean,
  sequential: boolean,
): vscode.ThemeIcon {
  switch (kind) {
    case 'ephemeral':
      return new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.orange'));
    case 'ttl':
      return new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.orange'));
    case 'container':
      return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.purple'));
    case 'persistent':
    case undefined:
      break;
  }
  if (sequential) {
    return new vscode.ThemeIcon('list-ordered', new vscode.ThemeColor('charts.green'));
  }
  return hasChildren
    ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'))
    : new vscode.ThemeIcon('symbol-file', new vscode.ThemeColor('charts.yellow'));
}

function kindText(kind: ZnodeKind | undefined, sequential: boolean): string | undefined {
  switch (kind) {
    case 'ephemeral':
      return vscode.l10n.t('Ephemeral: it ends with its session');
    case 'ttl':
      return vscode.l10n.t('Has a time to live');
    case 'container':
      return vscode.l10n.t('Container: deleted once its last child is gone');
    case 'persistent':
    case undefined:
    default:
      return sequential ? vscode.l10n.t('Sequential: its name ends in a counter') : undefined;
  }
}

export function zookeeperNodeItem(node: ZookeeperNodeNode): vscode.TreeItem {
  const children = node.numChildren ?? 0;
  const sequential = isSequentialName(node.name);
  const item = new vscode.TreeItem(
    node.path === ROOT_PATH ? '/' : node.name,
    // Every znode may get children; only one known to have none is a leaf.
    node.numChildren === 0 || node.denied === true
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = nodeId(node);
  item.iconPath =
    node.denied === true
      ? new vscode.ThemeIcon('lock', new vscode.ThemeColor('disabledForeground'))
      : zookeeperIcon(node.znodeKind, children > 0, sequential);
  if (children > 0) {
    item.description = formatCount(children, vscode.env.language);
  }
  item.tooltip = [
    node.path,
    children > 0
      ? vscode.l10n.t('{0} children', formatCount(children, vscode.env.language))
      : undefined,
    node.denied === true ? vscode.l10n.t('Its ACL does not let you read it') : undefined,
    kindText(node.znodeKind, sequential),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
  item.contextValue = TREE_CONTEXT.zookeeperNode;
  item.command = {
    command: 'datanest.zookeeper.openNode',
    title: vscode.l10n.t('Open Znode'),
    arguments: [node],
  };
  return item;
}

export function zookeeperMoreItem(node: ZookeeperMoreNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    vscode.l10n.t('Load more znodes…'),
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.description = vscode.l10n.t(
    '{0} of {1} loaded',
    formatCount(node.loaded, vscode.env.language),
    formatCount(node.total, vscode.env.language),
  );
  item.contextValue = TREE_CONTEXT.zookeeperMore;
  item.command = {
    command: 'datanest.zookeeper.loadMoreNodes',
    title: vscode.l10n.t('Load more znodes'),
    arguments: [node],
  };
  return item;
}

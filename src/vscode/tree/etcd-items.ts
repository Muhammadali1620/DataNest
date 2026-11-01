// How etcd nodes look in the tree (V13.19): folders made of key names with the number
// of keys below them, keys (clock-marked when a lease will end them), and "load more".

import * as vscode from 'vscode';
import { formatCount } from '../../core/number-format';
import {
  type EtcdFolderNode,
  type EtcdKeyNode,
  type EtcdMoreNode,
  nodeId,
  TREE_CONTEXT,
} from './nodes';

export function etcdFolderItem(node: EtcdFolderNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.name === '' ? '/' : node.name,
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'));
  if (node.count !== undefined) {
    item.description = formatCount(node.count, vscode.env.language);
  }
  item.tooltip = [
    node.prefix.text,
    node.count === undefined
      ? ''
      : vscode.l10n.t('{0} keys below', formatCount(node.count, vscode.env.language)),
  ]
    .filter((line) => line !== '')
    .join('\n');
  item.contextValue = TREE_CONTEXT.etcdFolder;
  return item;
}

export function etcdKeyItem(node: EtcdKeyNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
  item.id = nodeId(node);
  item.iconPath =
    node.leased === true
      ? new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.orange'))
      : new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow'));
  item.tooltip = [node.key.text, node.leased === true ? vscode.l10n.t('Ends with its lease') : '']
    .filter((line) => line !== '')
    .join('\n');
  item.contextValue = TREE_CONTEXT.etcdKey;
  item.command = {
    command: 'datanest.etcd.openKey',
    title: vscode.l10n.t('Open Key'),
    arguments: [node],
  };
  return item;
}

export function etcdMoreItem(node: EtcdMoreNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    vscode.l10n.t('Load more keys…'),
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.description = vscode.l10n.t('{0} loaded', formatCount(node.loaded, vscode.env.language));
  item.contextValue = TREE_CONTEXT.etcdMore;
  item.command = {
    command: 'datanest.etcd.loadMoreKeys',
    title: vscode.l10n.t('Load more keys'),
    arguments: [node],
  };
  return item;
}

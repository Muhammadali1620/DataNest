// How MongoDB nodes look in the tree (V7.5): databases with their size, collections and
// views with their kind, indexes with their keys and options.

import * as vscode from 'vscode';
import { formatBytes } from '../../services/mongodb/catalog';
import {
  type MongoCollectionNode,
  type MongoDatabaseNode,
  type MongoIndexNode,
  nodeId,
  TREE_CONTEXT,
} from './nodes';

export function mongoDatabaseItem(node: MongoDatabaseNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.database, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('database');
  item.contextValue = TREE_CONTEXT.mongoDatabase;
  if (node.sizeOnDisk !== undefined) {
    item.description = formatBytes(node.sizeOnDisk);
  }
  return item;
}

/** "view on orders · capped · validated": what sets a collection apart. */
export function collectionMarksText(node: MongoCollectionNode): string {
  const marks: string[] = [];
  if (node.collectionType === 'view') {
    marks.push(
      node.viewOn === undefined ? vscode.l10n.t('view') : vscode.l10n.t('view on {0}', node.viewOn),
    );
  }
  if (node.collectionType === 'timeseries') {
    marks.push(vscode.l10n.t('time series'));
  }
  if (node.capped === true) {
    marks.push(vscode.l10n.t('capped'));
  }
  if (node.validated === true) {
    marks.push(vscode.l10n.t('validated'));
  }
  return marks.join(' · ');
}

export function mongoCollectionItem(node: MongoCollectionNode): vscode.TreeItem {
  const view = node.collectionType === 'view';
  const item = new vscode.TreeItem(
    node.collection,
    view ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon(
    view ? 'eye' : node.collectionType === 'timeseries' ? 'graph-line' : 'files',
  );
  const marks = collectionMarksText(node);
  if (marks !== '') {
    item.description = marks;
  }
  item.tooltip = `${node.database}.${node.collection}`;
  item.contextValue = view ? TREE_CONTEXT.mongoView : TREE_CONTEXT.mongoCollection;
  item.command = {
    command: 'datanest.mongo.openCollection',
    title: vscode.l10n.t('Open Documents'),
    arguments: [node],
  };
  return item;
}

/** "{ email: 1 } · unique · TTL 3600 s". */
export function indexDescription(node: MongoIndexNode): string {
  const { index } = node;
  const marks = [index.keys];
  if (index.unique) {
    marks.push(vscode.l10n.t('unique'));
  }
  if (index.sparse) {
    marks.push(vscode.l10n.t('sparse'));
  }
  if (index.expireAfterSeconds !== undefined) {
    marks.push(vscode.l10n.t('TTL {0} s', index.expireAfterSeconds));
  }
  if (index.partial !== undefined) {
    marks.push(vscode.l10n.t('partial'));
  }
  if (index.hidden) {
    marks.push(vscode.l10n.t('hidden'));
  }
  return marks.join(' · ');
}

export function mongoIndexItem(node: MongoIndexNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.index.name, vscode.TreeItemCollapsibleState.None);
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon(node.index.primary ? 'key' : 'list-ordered');
  item.description = indexDescription(node);
  const lines = [`${node.index.name} — ${node.index.keys}`];
  if (node.index.partial !== undefined) {
    lines.push(vscode.l10n.t('Only documents that match {0}', node.index.partial));
  }
  item.tooltip = lines.join('\n');
  item.contextValue = node.index.primary ? TREE_CONTEXT.mongoIdIndex : TREE_CONTEXT.mongoIndex;
  return item;
}

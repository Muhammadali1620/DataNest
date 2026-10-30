// How Elasticsearch nodes look in the tree (V7.8): indices with their health, documents
// and size, mapping fields with their type.

import * as vscode from 'vscode';
import { formatBytes } from '../../services/mongodb/catalog';
import { type ElasticFieldNode, type ElasticIndexNode, nodeId, TREE_CONTEXT } from './nodes';
import { formatCount } from '../../core/number-format';

const HEALTH_COLORS: Readonly<Record<'green' | 'yellow' | 'red', string>> = {
  green: 'charts.green',
  yellow: 'charts.yellow',
  red: 'charts.red',
};

export function elasticIndexItem(node: ElasticIndexNode): vscode.TreeItem {
  const { index } = node;
  const item = new vscode.TreeItem(index.name, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon(
    index.status === 'close' ? 'lock' : 'symbol-namespace',
    index.health === undefined ? undefined : new vscode.ThemeColor(HEALTH_COLORS[index.health]),
  );
  const parts: string[] = [];
  if (index.status === 'close') {
    parts.push(vscode.l10n.t('closed'));
  }
  if (index.docs !== undefined) {
    parts.push(vscode.l10n.t('{0} docs', formatCount(Number(index.docs), vscode.env.language)));
  }
  if (index.size !== undefined) {
    parts.push(formatBytes(Number(index.size)));
  }
  item.description = parts.join(' · ');
  item.tooltip = [
    index.name,
    index.health === undefined ? '' : vscode.l10n.t('Health: {0}', index.health),
    vscode.l10n.t('The document count includes nested documents'),
  ]
    .filter((line) => line !== '')
    .join('\n');
  item.contextValue = TREE_CONTEXT.elasticIndex;
  return item;
}

function fieldIcon(type: string): string {
  switch (type) {
    case 'text':
    case 'keyword':
    case 'match_only_text':
    case 'wildcard':
      return 'symbol-string';
    case 'long':
    case 'integer':
    case 'short':
    case 'byte':
    case 'double':
    case 'float':
    case 'half_float':
    case 'scaled_float':
    case 'unsigned_long':
      return 'symbol-number';
    case 'date':
    case 'date_nanos':
      return 'calendar';
    case 'boolean':
      return 'symbol-boolean';
    case 'object':
    case 'nested':
    case 'flattened':
      return 'symbol-structure';
    case 'geo_point':
    case 'geo_shape':
      return 'location';
    default:
      return 'symbol-field';
  }
}

export function elasticFieldItem(node: ElasticFieldNode): vscode.TreeItem {
  const { field } = node;
  const item = new vscode.TreeItem(
    field.name,
    field.children.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon(fieldIcon(field.type));
  item.description = field.type;
  item.tooltip = `${field.path}: ${field.type}`;
  item.contextValue = TREE_CONTEXT.elasticField;
  return item;
}

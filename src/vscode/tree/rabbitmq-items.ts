// How RabbitMQ nodes look in the tree (V13.26): a virtual host, the Queues and Exchanges
// folders, a queue (coloured by how many messages wait in it) and an exchange (an icon and a
// colour for each type).

import * as vscode from 'vscode';
import { formatCount } from '../../core/number-format';
import {
  nodeId,
  type RabbitExchangeNode,
  type RabbitFolderNode,
  type RabbitQueueNode,
  type RabbitVhostNode,
  TREE_CONTEXT,
} from './nodes';

/** The tree item shows `/` as the default virtual host, as the broker's own pages do. */
export function rabbitVhostItem(node: RabbitVhostNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.vhost, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue'));
  item.tooltip = vscode.l10n.t('Virtual host "{0}"', node.vhost);
  item.contextValue = TREE_CONTEXT.rabbitVhost;
  return item;
}

export function rabbitFolderItem(node: RabbitFolderNode): vscode.TreeItem {
  if (node.folder === 'admin') {
    // A leaf that opens the page of the virtual host: connections, users and policies.
    const admin = new vscode.TreeItem(
      vscode.l10n.t('Administration'),
      vscode.TreeItemCollapsibleState.None,
    );
    admin.id = nodeId(node);
    admin.iconPath = new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.purple'));
    admin.tooltip = vscode.l10n.t(
      'Connections, users, permissions and policies of this virtual host',
    );
    admin.contextValue = TREE_CONTEXT.rabbitAdmin;
    admin.command = {
      command: 'datanest.rabbitmq.openObject',
      title: vscode.l10n.t('Open'),
      arguments: [node],
    };
    return admin;
  }
  const queues = node.folder === 'queues';
  const item = new vscode.TreeItem(
    queues ? vscode.l10n.t('Queues') : vscode.l10n.t('Exchanges'),
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = nodeId(node);
  item.iconPath = queues
    ? new vscode.ThemeIcon('list-unordered', new vscode.ThemeColor('charts.green'))
    : new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('charts.orange'));
  item.contextValue = queues ? TREE_CONTEXT.rabbitQueues : TREE_CONTEXT.rabbitExchanges;
  return item;
}

/** Green while empty, orange while messages wait, red when the queue is down. */
export function queueColor(node: RabbitQueueNode): string {
  if (node.state === 'down' || node.state === 'crashed' || node.state === 'stopped') {
    return 'charts.red';
  }
  return node.ready + node.unacked > 0 ? 'charts.orange' : 'charts.green';
}

export function rabbitQueueItem(node: RabbitQueueNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.queue, vscode.TreeItemCollapsibleState.None);
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('mail', new vscode.ThemeColor(queueColor(node)));
  const language = vscode.env.language;
  item.description = vscode.l10n.t(
    '{0} ready · {1} unacked · {2} consumers',
    formatCount(node.ready, language),
    formatCount(node.unacked, language),
    node.consumers,
  );
  item.tooltip = [node.queue, node.state].filter((line) => line !== '').join('\n');
  item.contextValue = TREE_CONTEXT.rabbitQueue;
  item.command = {
    command: 'datanest.rabbitmq.openObject',
    title: vscode.l10n.t('Open'),
    arguments: [node],
  };
  return item;
}

const EXCHANGE_ICONS: Readonly<Record<string, readonly [string, string]>> = {
  direct: ['arrow-right', 'charts.blue'],
  fanout: ['broadcast', 'charts.purple'],
  topic: ['symbol-namespace', 'charts.green'],
  headers: ['tag', 'charts.yellow'],
};

export function rabbitExchangeItem(node: RabbitExchangeNode): vscode.TreeItem {
  const isDefault = node.exchange === '';
  const item = new vscode.TreeItem(
    isDefault ? vscode.l10n.t('(AMQP default)') : node.exchange,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = nodeId(node);
  const [icon, color]: readonly [string, string] = isDefault
    ? ['circle-outline', 'disabledForeground']
    : (EXCHANGE_ICONS[node.exchangeType] ?? ['git-merge', 'charts.orange']);
  // The broker's own exchanges are dimmed, as the default one is.
  const own = node.exchange.startsWith('amq.');
  item.iconPath = new vscode.ThemeIcon(
    icon,
    new vscode.ThemeColor(own ? 'disabledForeground' : color),
  );
  item.description = node.exchangeType;
  item.contextValue = TREE_CONTEXT.rabbitExchange;
  item.command = {
    command: 'datanest.rabbitmq.openObject',
    title: vscode.l10n.t('Open'),
    arguments: [node],
  };
  return item;
}

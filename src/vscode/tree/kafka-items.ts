// How Kafka nodes look in the tree (V13.23): the Topics and Consumer groups folders, a
// topic (dimmed when it is the cluster's own), a partition with the offsets it holds and a
// consumer group with its state.

import * as vscode from 'vscode';
import { formatCount } from '../../core/number-format';
import {
  type KafkaGroupNode,
  type KafkaGroupsNode,
  type KafkaPartitionNode,
  type KafkaTopicNode,
  type KafkaTopicsNode,
  nodeId,
  TREE_CONTEXT,
} from './nodes';

export function kafkaTopicsItem(node: KafkaTopicsNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    vscode.l10n.t('Topics'),
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('list-unordered', new vscode.ThemeColor('charts.blue'));
  item.contextValue = TREE_CONTEXT.kafkaTopics;
  return item;
}

export function kafkaTopicItem(node: KafkaTopicNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.topic, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = nodeId(node);
  item.iconPath = node.internal
    ? new vscode.ThemeIcon('lock', new vscode.ThemeColor('disabledForeground'))
    : new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.green'));
  if (node.internal) {
    item.description = vscode.l10n.t('internal');
  }
  item.contextValue = TREE_CONTEXT.kafkaTopic;
  item.command = {
    command: 'datanest.kafka.openTopic',
    title: vscode.l10n.t('Open Topic'),
    arguments: [node],
  };
  return item;
}

export function kafkaPartitionItem(node: KafkaPartitionNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    vscode.l10n.t('Partition {0}', node.partition),
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.purple'));
  const count = Math.max(0, Number(node.high) - Number(node.low));
  item.description = vscode.l10n.t(
    '{0} messages · offsets {1}–{2}',
    formatCount(count, vscode.env.language),
    node.low,
    node.high,
  );
  item.tooltip = [
    vscode.l10n.t('Partition {0} of "{1}"', node.partition, node.topic),
    vscode.l10n.t(
      'The oldest message is at offset {0}; the next one gets {1}',
      node.low,
      node.high,
    ),
    node.leader < 0 ? vscode.l10n.t('No leader') : vscode.l10n.t('Led by broker {0}', node.leader),
  ].join('\n');
  item.contextValue = TREE_CONTEXT.kafkaPartition;
  item.command = {
    command: 'datanest.kafka.openTopic',
    title: vscode.l10n.t('Open Topic'),
    arguments: [node],
  };
  return item;
}

export function kafkaGroupsItem(node: KafkaGroupsNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    vscode.l10n.t('Consumer groups'),
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = nodeId(node);
  item.iconPath = new vscode.ThemeIcon('organization', new vscode.ThemeColor('charts.orange'));
  item.contextValue = TREE_CONTEXT.kafkaGroups;
  return item;
}

/** A group that is not running (`Empty`, `Dead`) is dimmed; a stable one is green. */
export function kafkaGroupItem(node: KafkaGroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = nodeId(node);
  const running = node.state === 'Stable';
  item.iconPath = new vscode.ThemeIcon(
    running ? 'pass-filled' : 'circle-outline',
    new vscode.ThemeColor(running ? 'charts.green' : 'disabledForeground'),
  );
  item.description = vscode.l10n.t('{0} · {1} members', node.state, node.members);
  item.contextValue = TREE_CONTEXT.kafkaGroup;
  return item;
}

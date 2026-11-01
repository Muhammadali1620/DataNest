// The children of Kafka nodes (V13.23): a connection holds its topics and its consumer
// groups; a topic holds its partitions; a group holds the lag it has per partition. Free of
// `vscode`. Asking the cluster is cheap but not free, so the model keeps nothing: a refresh
// of the tree is a new question.

import { formatCount } from '../../core/number-format';
import { ConnectionManager } from '../../services/connection-manager';
import type {
  KafkaGroupNode,
  KafkaGroupsNode,
  KafkaPartitionNode,
  KafkaTopicNode,
  KafkaTopicsNode,
  MessageNode,
  TreeNode,
} from './nodes';

export interface KafkaTreeDeps {
  readonly manager: Pick<ConnectionManager, 'acquireKafka'>;
  /** `datanest.kafka.showInternalTopics`. */
  readonly showInternalTopics: () => boolean;
  readonly language: () => string;
  readonly texts: {
    readonly noTopics: string;
    readonly noGroups: string;
    readonly noPartitions: string;
    readonly noLag: string;
    /** `orders: 12 behind`. */
    readonly lagLine: (topic: string, partition: number, lag: string) => string;
  };
}

function owner(connectionId: string): string {
  return ConnectionManager.treeOwner(connectionId);
}

/** A connection of Kafka: the two folders. */
export function kafkaConnectionChildren(connectionId: string): TreeNode[] {
  return [
    { kind: 'kafkaTopics', connectionId },
    { kind: 'kafkaGroups', connectionId },
  ];
}

export async function kafkaTopicChildren(
  deps: KafkaTreeDeps,
  node: KafkaTopicsNode,
): Promise<TreeNode[]> {
  const session = await deps.manager.acquireKafka(owner(node.connectionId), {
    connectionId: node.connectionId,
  });
  const show = deps.showInternalTopics();
  const topics = (await session.listTopics()).filter((topic) => show || !topic.internal);
  if (topics.length === 0) {
    return [message(deps.texts.noTopics, node.connectionId)];
  }
  return topics.map((topic): KafkaTopicNode => ({
    kind: 'kafkaTopic',
    connectionId: node.connectionId,
    topic: topic.name,
    internal: topic.internal,
  }));
}

export async function kafkaPartitionChildren(
  deps: KafkaTreeDeps,
  node: KafkaTopicNode,
): Promise<TreeNode[]> {
  const session = await deps.manager.acquireKafka(owner(node.connectionId), {
    connectionId: node.connectionId,
  });
  const details = await session.describeTopic(node.topic);
  if (details.partitions.length === 0) {
    return [message(deps.texts.noPartitions, node.connectionId)];
  }
  return details.partitions.map((partition): KafkaPartitionNode => ({
    kind: 'kafkaPartition',
    connectionId: node.connectionId,
    topic: node.topic,
    partition: partition.partition,
    low: partition.low,
    high: partition.high,
    leader: partition.leader,
  }));
}

export async function kafkaGroupChildren(
  deps: KafkaTreeDeps,
  node: KafkaGroupsNode,
): Promise<TreeNode[]> {
  const session = await deps.manager.acquireKafka(owner(node.connectionId), {
    connectionId: node.connectionId,
  });
  const groups = await session.listGroups();
  if (groups.length === 0) {
    return [message(deps.texts.noGroups, node.connectionId)];
  }
  return groups.map((group): KafkaGroupNode => ({
    kind: 'kafkaGroup',
    connectionId: node.connectionId,
    group: group.id,
    state: group.state,
    members: group.members,
  }));
}

/** The lag of a group, one line per partition it has committed an offset for. */
export async function kafkaLagChildren(
  deps: KafkaTreeDeps,
  node: KafkaGroupNode,
): Promise<TreeNode[]> {
  const session = await deps.manager.acquireKafka(owner(node.connectionId), {
    connectionId: node.connectionId,
  });
  const lags = await session.groupLag(node.group);
  if (lags.length === 0) {
    return [message(deps.texts.noLag, node.connectionId)];
  }
  return lags.map((lag) =>
    message(
      deps.texts.lagLine(lag.topic, lag.partition, formatCount(Number(lag.lag), deps.language())),
      node.connectionId,
    ),
  );
}

function message(text: string, connectionId: string): MessageNode {
  return { kind: 'message', text, connectionId };
}

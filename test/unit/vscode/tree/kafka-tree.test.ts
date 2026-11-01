import { describe, expect, it } from 'vitest';
import { openKafkaSession } from '../../../../src/drivers/kafka/session';
import {
  kafkaConnectionChildren,
  kafkaGroupChildren,
  kafkaLagChildren,
  kafkaPartitionChildren,
  kafkaTopicChildren,
  type KafkaTreeDeps,
} from '../../../../src/vscode/tree/kafka-tree';
import { nameOf, nodeId, type TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeKafka } from '../../../helpers/fake-kafka';

async function setup(showInternal = false) {
  const cluster = new FakeKafka();
  cluster.addTopic('orders', 2);
  cluster.addTopic('__consumer_offsets', 1);
  cluster.append('orders', 0, 'a');
  cluster.append('orders', 0, 'b');
  cluster.commit('billing', 'orders', 0, 1);
  cluster.groupStates.set('idle', 'Empty');
  const session = await openKafkaSession(
    { id: 'k1', name: 'K', driver: 'kafka', host: 'h' },
    cluster.factory,
  );
  const owners: string[] = [];
  const deps: KafkaTreeDeps = {
    manager: {
      acquireKafka: (owner) => {
        owners.push(owner);
        return Promise.resolve(session);
      },
    },
    showInternalTopics: () => showInternal,
    language: () => 'en',
    texts: {
      noTopics: 'No topics',
      noGroups: 'No groups',
      noPartitions: 'No partitions',
      noLag: 'No offsets',
      lagLine: (topic, partition, lag) => `${topic}[${partition}]: ${lag} behind`,
    },
  };
  return { cluster, deps, owners };
}

describe('Kafka tree', () => {
  it('shows a connection as its two folders', () => {
    expect(kafkaConnectionChildren('k1')).toEqual([
      { kind: 'kafkaTopics', connectionId: 'k1' },
      { kind: 'kafkaGroups', connectionId: 'k1' },
    ]);
  });

  it('lists topics without the cluster’s own, unless asked', async () => {
    const hidden = await setup(false);
    const topics = await kafkaTopicChildren(hidden.deps, {
      kind: 'kafkaTopics',
      connectionId: 'k1',
    });
    expect(topics).toEqual([
      { kind: 'kafkaTopic', connectionId: 'k1', topic: 'orders', internal: false },
    ]);
    const shown = await setup(true);
    const all = await kafkaTopicChildren(shown.deps, { kind: 'kafkaTopics', connectionId: 'k1' });
    expect(
      all.map((node) => (node.kind === 'kafkaTopic' ? [node.topic, node.internal] : null)),
    ).toEqual([
      ['__consumer_offsets', true],
      ['orders', false],
    ]);
  });

  it('uses the tree’s own session', async () => {
    const { deps, owners } = await setup();
    await kafkaTopicChildren(deps, { kind: 'kafkaTopics', connectionId: 'k1' });
    expect(owners).toEqual(['tree:k1']);
  });

  it('says so when there are no topics', async () => {
    const { cluster, deps } = await setup();
    cluster.topics.clear();
    expect(await kafkaTopicChildren(deps, { kind: 'kafkaTopics', connectionId: 'k1' })).toEqual([
      { kind: 'message', text: 'No topics', connectionId: 'k1' },
    ]);
  });

  it('lists the partitions of a topic with their offsets', async () => {
    const { deps } = await setup();
    const parts = await kafkaPartitionChildren(deps, {
      kind: 'kafkaTopic',
      connectionId: 'k1',
      topic: 'orders',
      internal: false,
    });
    expect(parts).toEqual([
      {
        kind: 'kafkaPartition',
        connectionId: 'k1',
        topic: 'orders',
        partition: 0,
        low: '0',
        high: '2',
        leader: 1,
      },
      {
        kind: 'kafkaPartition',
        connectionId: 'k1',
        topic: 'orders',
        partition: 1,
        low: '0',
        high: '0',
        leader: 1,
      },
    ]);
  });

  it('lists the consumer groups with state and members', async () => {
    const { deps } = await setup();
    const groups = await kafkaGroupChildren(deps, { kind: 'kafkaGroups', connectionId: 'k1' });
    expect(groups).toEqual([
      { kind: 'kafkaGroup', connectionId: 'k1', group: 'billing', state: 'Stable', members: 2 },
      { kind: 'kafkaGroup', connectionId: 'k1', group: 'idle', state: 'Empty', members: 0 },
    ]);
  });

  it('says so when there are no groups', async () => {
    const { cluster, deps } = await setup();
    cluster.groups.clear();
    cluster.groupStates.clear();
    expect(
      (await kafkaGroupChildren(deps, { kind: 'kafkaGroups', connectionId: 'k1' }))[0],
    ).toMatchObject({
      kind: 'message',
      text: 'No groups',
    });
  });

  it('shows the lag of a group, one line per partition', async () => {
    const { deps } = await setup();
    const lines = await kafkaLagChildren(deps, {
      kind: 'kafkaGroup',
      connectionId: 'k1',
      group: 'billing',
      state: 'Stable',
      members: 1,
    });
    expect(lines).toEqual([{ kind: 'message', text: 'orders[0]: 1 behind', connectionId: 'k1' }]);
  });

  it('says so when a group has committed nothing', async () => {
    const { deps } = await setup();
    const lines = await kafkaLagChildren(deps, {
      kind: 'kafkaGroup',
      connectionId: 'k1',
      group: 'idle',
      state: 'Empty',
      members: 0,
    });
    expect(lines[0]).toMatchObject({ text: 'No offsets' });
  });
});

describe('Kafka nodes', () => {
  const nodes: TreeNode[] = [
    { kind: 'kafkaTopics', connectionId: 'k1' },
    { kind: 'kafkaTopic', connectionId: 'k1', topic: 'orders', internal: false },
    {
      kind: 'kafkaPartition',
      connectionId: 'k1',
      topic: 'orders',
      partition: 0,
      low: '0',
      high: '1',
      leader: 1,
    },
    { kind: 'kafkaGroups', connectionId: 'k1' },
    { kind: 'kafkaGroup', connectionId: 'k1', group: 'billing', state: 'Stable', members: 1 },
  ];

  it('gives every node an id of its own', () => {
    expect(new Set(nodes.map((node) => nodeId(node))).size).toBe(nodes.length);
  });

  it('keeps ids apart for the same name on two connections or in two topics', () => {
    const a: TreeNode = {
      kind: 'kafkaTopic',
      connectionId: 'k1',
      topic: 'orders',
      internal: false,
    };
    const b: TreeNode = {
      kind: 'kafkaTopic',
      connectionId: 'k2',
      topic: 'orders',
      internal: false,
    };
    expect(nodeId(a)).not.toBe(nodeId(b));
    const p0: TreeNode = {
      kind: 'kafkaPartition',
      connectionId: 'k1',
      topic: 'a',
      partition: 1,
      low: '0',
      high: '0',
      leader: 1,
    };
    const p1: TreeNode = { ...p0, topic: 'a:1', partition: 0 };
    expect(nodeId(p0)).not.toBe(nodeId(p1));
  });

  it('copies the name of a topic and of a group, and of nothing else', () => {
    expect(nodes.map((node) => nameOf(node))).toEqual([
      undefined,
      'orders',
      undefined,
      undefined,
      'billing',
    ]);
  });
});

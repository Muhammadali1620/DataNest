import { describe, expect, it } from 'vitest';
import { openKafkaSession } from '../../../../src/drivers/kafka/session';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import {
  DEFAULT_PARTITIONS,
  kafkaCommandHandlers,
  type KafkaCommandUi,
  MAX_TOPIC_NAME,
  topicNameProblem,
} from '../../../../src/vscode/kafka/kafka-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeKafka } from '../../../helpers/fake-kafka';

interface Scenario {
  inputs?: (string | undefined)[];
  confirm?: boolean;
  pick?: string | undefined;
  /** What the quick pick answers, one per question; `undefined` backs out. */
  picks?: unknown[];
  connections?: ConnectionConfig[];
}

const kafka = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'k1',
  name: 'Local Kafka',
  driver: 'kafka',
  host: 'h',
  ...extra,
});

async function setup(scenario: Scenario = {}) {
  const cluster = new FakeKafka();
  cluster.addTopic('orders', 1);
  const session = await openKafkaSession(
    { id: 'k1', name: 'Local Kafka', driver: 'kafka', host: 'h' },
    cluster.factory,
  );
  const connections = scenario.connections ?? [kafka()];
  const inputs = [...(scenario.inputs ?? [])];
  const picks = [...(scenario.picks ?? [])];
  const pickAsked: { labels: string[]; placeholder: string }[] = [];
  const asked: string[] = [];
  const confirms: { message: string; detail: string | undefined }[] = [];
  const infos: string[] = [];
  const opened: [string, string, boolean][] = [];
  const refreshed: (TreeNode | undefined)[] = [];
  const ui: KafkaCommandUi = {
    input: (options) => {
      asked.push(options.prompt);
      const next = inputs.shift();
      if (next !== undefined && options.validate?.(next) !== undefined) {
        throw new Error(`rejected: ${options.validate(next)}`);
      }
      return Promise.resolve(next);
    },
    confirm: (message, detail) => {
      confirms.push({ message, detail });
      return Promise.resolve(scenario.confirm ?? true);
    },
    pick: <T>(items: readonly { label: string; value: T }[], placeholder: string) => {
      pickAsked.push({ labels: items.map((one) => one.label), placeholder });
      return Promise.resolve(picks.shift() as T | undefined);
    },
    pickConnection: () => Promise.resolve(scenario.pick),
    info: (message) => {
      infos.push(message);
    },
  };
  const handlers = kafkaCommandHandlers({
    store: {
      get: (id) => connections.find((one) => one.id === id),
      list: () => connections,
    },
    session: () => Promise.resolve(session),
    tree: {
      refresh: (node) => {
        refreshed.push(node);
      },
    },
    ui,
    openTopic: (connectionId, topic, internal) => {
      opened.push([connectionId, topic, internal]);
      return Promise.resolve();
    },
    texts: { noKafka: 'no kafka', readOnly: 'read-only' },
  });
  return { cluster, handlers, asked, confirms, infos, opened, refreshed, pickAsked };
}

const topicNode = (topic = 'orders'): TreeNode => ({
  kind: 'kafkaTopic',
  connectionId: 'k1',
  topic,
  internal: topic.startsWith('_'),
});

describe('topicNameProblem', () => {
  it('takes what Kafka takes', () => {
    for (const name of ['orders', 'a.b-c_d', 'A1', 'x'.repeat(MAX_TOPIC_NAME)]) {
      expect(topicNameProblem(name)).toBeUndefined();
    }
  });

  it('refuses what Kafka refuses', () => {
    for (const name of ['', '.', '..', 'x'.repeat(MAX_TOPIC_NAME + 1), 'a b', 'a/b', 'ключ']) {
      expect(topicNameProblem(name)).toBeTypeOf('string');
    }
  });
});

describe('open topic', () => {
  it('opens a topic from its node and from one of its partitions', async () => {
    const { handlers, opened } = await setup();
    await handlers.openTopic(topicNode());
    await handlers.openTopic({
      kind: 'kafkaPartition',
      connectionId: 'k1',
      topic: '__consumer_offsets',
      partition: 4,
      low: '0',
      high: '1',
      leader: 1,
    });
    expect(opened).toEqual([
      ['k1', 'orders', false],
      ['k1', '__consumer_offsets', true],
    ]);
  });

  it('ignores anything else', async () => {
    const { handlers, opened } = await setup();
    await handlers.openTopic(undefined);
    await handlers.openTopic({ kind: 'kafkaGroups', connectionId: 'k1' });
    expect(opened).toEqual([]);
  });
});

describe('new topic', () => {
  it('asks for a name, partitions and copies, then creates the topic', async () => {
    const { cluster, handlers, infos, refreshed } = await setup({ inputs: [' fresh ', '3', '1'] });
    await handlers.newTopic({ kind: 'kafkaTopics', connectionId: 'k1' });
    expect(cluster.topics.get('fresh')).toHaveLength(3);
    expect(refreshed).toEqual([{ kind: 'kafkaTopics', connectionId: 'k1' }]);
    expect(infos[0]).toMatch(/fresh/u);
  });

  it('starts from one partition and one copy', async () => {
    expect(DEFAULT_PARTITIONS).toBe(1);
    const { cluster, handlers } = await setup({ inputs: ['solo', '1', '1'] });
    await handlers.newTopic(undefined);
    expect(cluster.topics.get('solo')).toHaveLength(1);
  });

  it('stops at any question the user backs out of', async () => {
    for (const inputs of [[undefined], ['x', undefined], ['x', '2', undefined]]) {
      const { cluster, handlers } = await setup({ inputs });
      await handlers.newTopic({ kind: 'kafkaTopics', connectionId: 'k1' });
      expect([...cluster.topics.keys()]).toEqual(['orders']);
    }
  });

  it('checks the answers as they are typed', async () => {
    await expect(
      (await setup({ inputs: ['bad name'] })).handlers.newTopic(undefined),
    ).rejects.toThrow(/rejected/u);
    await expect(
      (await setup({ inputs: ['ok', '0'] })).handlers.newTopic(undefined),
    ).rejects.toThrow(/rejected/u);
    await expect(
      (await setup({ inputs: ['ok', '2', 'many'] })).handlers.newTopic(undefined),
    ).rejects.toThrow(/rejected/u);
  });

  it('refuses a read-only connection before asking anything', async () => {
    const { asked, handlers } = await setup({ connections: [kafka({ readOnly: true })] });
    await expect(
      handlers.newTopic({ kind: 'kafkaTopics', connectionId: 'k1' }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(asked).toEqual([]);
  });

  it('asks once more on a production connection, and creates nothing when the answer is no', async () => {
    const taken = await setup({
      connections: [kafka({ production: true })],
      inputs: ['p', '1', '1'],
    });
    await taken.handlers.newTopic(undefined);
    expect(taken.confirms[0]?.message).toMatch(/production/u);
    expect(taken.cluster.topics.has('p')).toBe(true);
    const refused = await setup({
      connections: [kafka({ production: true })],
      inputs: ['p', '1', '1'],
      confirm: false,
    });
    await refused.handlers.newTopic(undefined);
    expect(refused.cluster.topics.has('p')).toBe(false);
  });

  it('works on the only Kafka connection when run from the palette, and asks among several', async () => {
    const one = await setup({
      connections: [kafka(), { id: 'sql', name: 'x', driver: 'mysql' }],
      inputs: ['a', '1', '1'],
    });
    await one.handlers.newTopic(undefined);
    expect(one.cluster.topics.has('a')).toBe(true);
    const two = await setup({
      connections: [kafka(), kafka({ id: 'k2', name: 'Second' })],
      pick: undefined,
    });
    await two.handlers.newTopic(undefined);
    expect(two.asked).toEqual([]);
  });

  it('says so when there is no Kafka connection', async () => {
    const { handlers } = await setup({ connections: [{ id: 'sql', name: 'x', driver: 'mysql' }] });
    await expect(handlers.newTopic(undefined)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a connection that is not Kafka', async () => {
    const { handlers } = await setup({ connections: [{ id: 'k1', name: 'x', driver: 'mysql' }] });
    await expect(
      handlers.newTopic({ kind: 'kafkaTopics', connectionId: 'k1' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('delete topic', () => {
  it('deletes the topic after the user agrees', async () => {
    const { cluster, handlers, refreshed, confirms } = await setup();
    await handlers.deleteTopic(topicNode());
    expect(cluster.topics.has('orders')).toBe(false);
    expect(confirms[0]?.message).toMatch(/orders/u);
    expect(refreshed).toEqual([{ kind: 'kafkaTopics', connectionId: 'k1' }]);
  });

  it('keeps the topic when the user does not agree', async () => {
    const { cluster, handlers } = await setup({ confirm: false });
    await handlers.deleteTopic(topicNode());
    expect(cluster.topics.has('orders')).toBe(true);
  });

  it('names a production connection in the question', async () => {
    const { confirms, handlers } = await setup({ connections: [kafka({ production: true })] });
    await handlers.deleteTopic(topicNode());
    expect(confirms[0]?.detail).toMatch(/production/u);
  });

  it('refuses a read-only connection, and anything that is not a topic', async () => {
    const readOnly = await setup({ connections: [kafka({ readOnly: true })] });
    await expect(readOnly.handlers.deleteTopic(topicNode())).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(readOnly.cluster.topics.has('orders')).toBe(true);
    const other = await setup();
    await other.handlers.deleteTopic(undefined);
    await other.handlers.deleteTopic({ kind: 'kafkaGroups', connectionId: 'k1' });
    expect(other.confirms).toEqual([]);
  });
});

describe('reset offsets (V13.29)', () => {
  const groupNode = (group = 'billing'): TreeNode => ({
    kind: 'kafkaGroup',
    connectionId: 'k1',
    group,
    state: 'Empty',
    members: 0,
  });

  async function withGroup(scenario: Scenario = {}) {
    const made = await setup(scenario);
    for (let i = 0; i < 6; i++) {
      made.cluster.append('orders', 0, `m${i}`, { at: 1000 * (i + 1) });
    }
    made.cluster.commit('billing', 'orders', 0, 4);
    made.cluster.groupStates.set('billing', 'Empty');
    return made;
  }

  it.each([
    ['earliest', undefined, '0'],
    ['latest', undefined, '6'],
  ] as const)('moves the group to %s after the user agrees', async (kind, _unused, offset) => {
    const { cluster, handlers, confirms, infos, refreshed } = await withGroup({ picks: [kind] });
    await handlers.resetOffsets(groupNode());
    expect(cluster.setOffsetCalls[0]?.partitions).toEqual([{ partition: 0, offset }]);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.message).toMatch(/billing/u);
    expect(refreshed).toEqual([groupNode()]);
    expect(infos[0]).toMatch(/billing/u);
  });

  it('asks for an offset and checks it as it is typed', async () => {
    const { cluster, handlers, asked } = await withGroup({ picks: ['offset'], inputs: ['3'] });
    await handlers.resetOffsets(groupNode());
    expect(asked).toHaveLength(1);
    expect(cluster.setOffsetCalls[0]?.partitions).toEqual([{ partition: 0, offset: '3' }]);
    const bad = await withGroup({ picks: ['offset'], inputs: ['-1'] });
    await expect(bad.handlers.resetOffsets(groupNode())).rejects.toThrow(/rejected/u);
    const text = await withGroup({ picks: ['offset'], inputs: ['x'] });
    await expect(text.handlers.resetOffsets(groupNode())).rejects.toThrow(/rejected/u);
  });

  it('moves to the end for a moment after the last message, and checks the moment as it is typed', async () => {
    const { cluster, handlers } = await withGroup({ picks: ['time'], inputs: ['2999-01-01'] });
    await handlers.resetOffsets(groupNode());
    expect(cluster.setOffsetCalls[0]?.partitions).toEqual([{ partition: 0, offset: '6' }]);
    const bad = await withGroup({ picks: ['time'], inputs: ['not a date'] });
    await expect(bad.handlers.resetOffsets(groupNode())).rejects.toThrow(/rejected/u);
  });

  it('reads a moment typed as a date', async () => {
    const { cluster, handlers } = await withGroup({
      picks: ['time'],
      inputs: ['1970-01-01T00:00:04Z'],
    });
    await handlers.resetOffsets(groupNode());
    expect(cluster.setOffsetCalls[0]?.partitions).toEqual([{ partition: 0, offset: '3' }]);
  });

  it('stops at any question the user backs out of, and commits nothing', async () => {
    for (const scenario of [
      { picks: [undefined] },
      { picks: ['offset'], inputs: [undefined] },
      { picks: ['time'], inputs: [undefined] },
      { picks: ['latest'], confirm: false },
    ] as Scenario[]) {
      const { cluster, handlers } = await withGroup(scenario);
      await handlers.resetOffsets(groupNode());
      expect(cluster.setOffsetCalls, JSON.stringify(scenario)).toEqual([]);
    }
  });

  it('asks which topic when the group has offsets on several', async () => {
    const { cluster, handlers, pickAsked } = await withGroup({ picks: ['audit', 'latest'] });
    cluster.addTopic('audit', 1);
    cluster.append('audit', 0, 'a');
    cluster.commit('billing', 'audit', 0, 0);
    await handlers.resetOffsets(groupNode());
    expect(pickAsked[0]?.labels).toEqual(['audit', 'orders']);
    expect(cluster.setOffsetCalls[0]?.topic).toBe('audit');
  });

  it('says so when the group has no offsets', async () => {
    const { handlers, infos, cluster } = await withGroup();
    cluster.groups.delete('billing');
    await handlers.resetOffsets(groupNode());
    expect(infos[0]).toMatch(/no offsets/u);
    expect(cluster.setOffsetCalls).toEqual([]);
  });

  it('names a production connection in the question', async () => {
    const { handlers, confirms } = await withGroup({
      picks: ['latest'],
      connections: [kafka({ production: true })],
    });
    await handlers.resetOffsets(groupNode());
    expect(confirms[0]?.detail).toMatch(/production/u);
  });

  it('refuses a read-only connection before asking anything, and anything that is not a group', async () => {
    const { handlers, pickAsked, cluster } = await withGroup({
      connections: [kafka({ readOnly: true })],
    });
    await expect(handlers.resetOffsets(groupNode())).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(pickAsked).toEqual([]);
    expect(await handlers.resetOffsets(undefined)).toBeUndefined();
    expect(await handlers.resetOffsets(topicNode())).toBeUndefined();
    expect(cluster.setOffsetCalls).toEqual([]);
  });

  it('passes on the broker’s refusal of a group that is running', async () => {
    const { handlers, cluster } = await withGroup({ picks: ['latest'] });
    cluster.groupStates.set('billing', 'Stable');
    await expect(handlers.resetOffsets(groupNode())).rejects.toMatchObject({
      code: 'constraint',
    });
  });
});

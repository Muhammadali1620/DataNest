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
  return { cluster, handlers, asked, confirms, infos, opened, refreshed };
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

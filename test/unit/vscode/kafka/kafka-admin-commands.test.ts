import { describe, expect, it } from 'vitest';
import { openKafkaSession } from '../../../../src/drivers/kafka/session';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import {
  describeAcl,
  kafkaAdminHandlers,
  principalProblem,
} from '../../../../src/vscode/kafka/kafka-admin-commands';
import type { KafkaCommandUi } from '../../../../src/vscode/kafka/kafka-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeKafka } from '../../../helpers/fake-kafka';

interface Item {
  label: string;
  description?: string;
  value: unknown;
}
/** A pick answer: a value, `undefined` to back out, or a function that chooses among the items. */
type Answer = unknown;

interface Scenario {
  inputs?: (string | undefined)[];
  confirm?: boolean;
  picks?: Answer[];
  connections?: ConnectionConfig[];
  brokers?: number;
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
  cluster.brokers = scenario.brokers ?? 1;
  const session = await openKafkaSession(
    { id: 'k1', name: 'Local Kafka', driver: 'kafka', host: 'h' },
    cluster.factory,
  );
  const connections = scenario.connections ?? [kafka()];
  const inputs = [...(scenario.inputs ?? [])];
  const picks = [...(scenario.picks ?? [])];
  const asked: string[] = [];
  const lists: Item[][] = [];
  const placeholders: string[] = [];
  const confirms: { message: string; detail: string | undefined }[] = [];
  const infos: string[] = [];
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
    pick: <T>(items: readonly Item[], placeholder: string) => {
      lists.push([...items]);
      placeholders.push(placeholder);
      const next = picks.shift();
      return Promise.resolve(
        (typeof next === 'function'
          ? (next as (items: readonly Item[]) => unknown)(items)
          : next) as T | undefined,
      );
    },
    pickConnection: () => Promise.resolve('k1'),
    info: (message) => {
      infos.push(message);
    },
  };
  const handlers = kafkaAdminHandlers({
    store: {
      get: (id) => connections.find((one) => one.id === id),
      list: () => connections,
    },
    session: () => Promise.resolve(session),
    tree: { refresh: () => undefined },
    ui,
    openTopic: () => Promise.resolve(),
    texts: { noKafka: 'no kafka', readOnly: 'read-only' },
  });
  return { cluster, handlers, asked, lists, placeholders, confirms, infos, inputs, picks };
}

const connectionNode: TreeNode = { kind: 'connection', connectionId: 'k1' };
const topicNode: TreeNode = {
  kind: 'kafkaTopic',
  connectionId: 'k1',
  topic: 'orders',
  internal: false,
};

const addRule = (items: readonly Item[]): unknown => items[0]?.value;
const pickLabel =
  (label: string) =>
  (items: readonly Item[]): unknown =>
    items.find((one) => one.label.startsWith(label))?.value;
const pickValue =
  (value: unknown) =>
  (items: readonly Item[]): unknown =>
    items.find((one) => one.value === value)?.value;

describe('describeAcl and principalProblem (V13.34)', () => {
  const base = {
    resource: 'topic',
    name: 'orders',
    pattern: 'literal',
    principal: 'User:alice',
    host: '*',
    operation: 'read',
    permission: 'allow',
  } as const;

  it('puts a rule in a sentence', () => {
    expect(describeAcl(base)).toBe('User:alice may read topic "orders"');
    expect(describeAcl({ ...base, permission: 'deny', operation: 'write' })).toBe(
      'User:alice may not write topic "orders"',
    );
    expect(describeAcl({ ...base, pattern: 'prefixed', name: 'app-' })).toBe(
      'User:alice may read topic "app-…"',
    );
    expect(describeAcl({ ...base, resource: 'cluster', name: 'kafka-cluster' })).toBe(
      'User:alice may read the cluster',
    );
  });

  it('takes Type:name and refuses the rest', () => {
    for (const ok of ['User:alice', 'User:*', 'Group:ops', 'User:a:b']) {
      expect(principalProblem(ok)).toBeUndefined();
    }
    for (const bad of ['alice', 'User:', ':x', '1:x', '']) {
      expect(principalProblem(bad)).toBeTypeOf('string');
    }
  });
});

describe('Kafka access rules command (V13.34)', () => {
  it('lists the rules and the way to make one, and ends when the user backs out', async () => {
    const run = await setup({ picks: [undefined] });
    run.cluster.acls.push({
      resourceType: 2,
      resourceName: 'orders',
      resourcePatternType: 3,
      principal: 'User:bob',
      host: '*',
      operation: 3,
      permissionType: 3,
    });
    await run.handlers.manageAcls(connectionNode);
    expect(run.lists[0]?.map((one) => one.label)).toEqual([
      '$(add) New rule…',
      'User:bob may read topic "orders"',
    ]);
    expect(run.lists[0]?.[0]?.description).toBe('1 rules');
    expect(run.confirms).toEqual([]);
  });

  it('makes a rule step by step and asks first', async () => {
    const run = await setup({
      picks: [addRule, 'topic', 'literal', 'read', 'allow', undefined],
      inputs: ['User:alice', 'orders', '*'],
    });
    await run.handlers.manageAcls(connectionNode);
    expect(run.cluster.acls).toHaveLength(1);
    expect(run.cluster.acls[0]).toMatchObject({
      resourceType: 2,
      resourceName: 'orders',
      resourcePatternType: 3,
      principal: 'User:alice',
      host: '*',
      operation: 3,
      permissionType: 3,
    });
    expect(run.confirms[0]?.message).toBe('Make the rule: User:alice may read topic "orders"?');
    expect(run.infos).toEqual(['The rule is made']);
    // The list was shown again after the change.
    expect(run.lists).toHaveLength(6);
    expect(run.lists.at(-1)?.[0]?.description).toBe('1 rules');
  });

  it('skips the name and the pattern for the cluster, and the pattern for *', async () => {
    const cluster = await setup({
      picks: [addRule, 'cluster', 'create', 'deny', undefined],
      inputs: ['User:*', '10.0.0.1'],
    });
    await cluster.handlers.manageAcls(connectionNode);
    expect(cluster.cluster.acls[0]).toMatchObject({
      resourceType: 4,
      resourceName: 'kafka-cluster',
      principal: 'User:*',
      host: '10.0.0.1',
      permissionType: 2,
    });
    const every = await setup({
      picks: [addRule, 'group', 'read', 'allow', undefined],
      inputs: ['User:alice', '*', '*'],
    });
    await every.handlers.manageAcls(connectionNode);
    expect(every.cluster.acls[0]).toMatchObject({
      resourceType: 3,
      resourceName: '*',
      resourcePatternType: 3,
    });
  });

  it('makes a rule for a whole family of names', async () => {
    const run = await setup({
      picks: [addRule, 'topic', 'prefixed', 'write', 'allow', undefined],
      inputs: ['User:alice', ' app- ', '*'],
    });
    await run.handlers.manageAcls(connectionNode);
    expect(run.cluster.acls[0]).toMatchObject({ resourceName: 'app-', resourcePatternType: 4 });
  });

  it('drops a rule the user does not confirm, and one backed out of at each step', async () => {
    const no = await setup({
      picks: [addRule, 'topic', 'literal', 'read', 'allow', undefined],
      inputs: ['User:alice', 'orders', '*'],
      confirm: false,
    });
    await no.handlers.manageAcls(connectionNode);
    expect(no.cluster.acls).toEqual([]);
    expect(no.infos).toEqual([]);
    const steps: { picks: Answer[]; inputs: (string | undefined)[] }[] = [
      { picks: [addRule, undefined], inputs: [undefined] },
      { picks: [addRule, undefined, undefined], inputs: ['User:a'] },
      { picks: [addRule, 'topic', undefined], inputs: ['User:a', undefined] },
      { picks: [addRule, 'topic', undefined, undefined], inputs: ['User:a', 'orders'] },
      { picks: [addRule, 'topic', 'literal', undefined, undefined], inputs: ['User:a', 'orders'] },
      {
        picks: [addRule, 'topic', 'literal', 'read', undefined, undefined],
        inputs: ['User:a', 'orders'],
      },
      {
        picks: [addRule, 'topic', 'literal', 'read', 'allow', undefined],
        inputs: ['User:a', 'orders', undefined],
      },
    ];
    for (const step of steps) {
      const run = await setup(step);
      await run.handlers.manageAcls(connectionNode);
      expect(run.cluster.acls).toEqual([]);
      expect(run.confirms).toEqual([]);
    }
  });

  it('removes a rule after asking, and says when it was already gone', async () => {
    const run = await setup({ picks: [pickLabel('User:bob'), undefined] });
    run.cluster.acls.push({
      resourceType: 2,
      resourceName: 'orders',
      resourcePatternType: 3,
      principal: 'User:bob',
      host: '*',
      operation: 3,
      permissionType: 3,
    });
    await run.handlers.manageAcls(connectionNode);
    expect(run.cluster.acls).toEqual([]);
    expect(run.confirms[0]?.message).toBe('Remove the rule: User:bob may read topic "orders"?');
    expect(run.infos).toEqual(['The rule is removed']);
    const gone = await setup({
      picks: [
        (items: readonly Item[]) => {
          run.cluster.acls.length = 0;
          return items[1]?.value;
        },
        undefined,
      ],
    });
    gone.cluster.acls.push({
      resourceType: 2,
      resourceName: 'orders',
      resourcePatternType: 3,
      principal: 'User:bob',
      host: '*',
      operation: 3,
      permissionType: 3,
    });
    gone.picks[0] = (items: readonly Item[]) => {
      gone.cluster.acls.length = 0;
      return items[1]?.value;
    };
    await gone.handlers.manageAcls(connectionNode);
    expect(gone.infos).toEqual(['The rule was already gone']);
  });

  it('keeps a rule the user will not remove', async () => {
    const run = await setup({ picks: [pickLabel('User:bob'), undefined], confirm: false });
    run.cluster.acls.push({
      resourceType: 2,
      resourceName: 'orders',
      resourcePatternType: 3,
      principal: 'User:bob',
      host: '*',
      operation: 3,
      permissionType: 3,
    });
    await run.handlers.manageAcls(connectionNode);
    expect(run.cluster.acls).toHaveLength(1);
  });

  it('says that a production connection is one', async () => {
    const run = await setup({
      connections: [kafka({ production: true })],
      picks: [addRule, 'topic', 'literal', 'read', 'allow', undefined],
      inputs: ['User:alice', 'orders', '*'],
      confirm: false,
    });
    await run.handlers.manageAcls(connectionNode);
    expect(run.confirms[0]?.detail).toContain('production connection');
  });

  it('refuses on a read-only connection once something is chosen, and without a Kafka connection', async () => {
    const readOnly = await setup({ connections: [kafka({ readOnly: true })], picks: [addRule] });
    await expect(readOnly.handlers.manageAcls(connectionNode)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    const none = await setup({ connections: [] });
    await expect(none.handlers.manageAcls(undefined)).rejects.toMatchObject({ code: 'not-found' });
    const other = await setup({ connections: [kafka({ driver: 'mysql' })] });
    await expect(other.handlers.manageAcls(connectionNode)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('asks which connection when none was clicked', async () => {
    const run = await setup({ connections: [kafka(), kafka({ id: 'k2' })], picks: [undefined] });
    await run.handlers.manageAcls(undefined);
    expect(run.lists).toHaveLength(1);
    const one = await setup({ picks: [undefined] });
    await one.handlers.manageAcls(undefined);
    expect(one.lists).toHaveLength(1);
  });

  it('shows what a cluster without an authorizer answers', async () => {
    const run = await setup();
    run.cluster.securityDisabled = true;
    await expect(run.handlers.manageAcls(connectionNode)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('Kafka settings command (V13.34)', () => {
  const setting = (name: string) => (items: readonly Item[]) =>
    items.find((one) => one.label.startsWith(`${name} =`))?.value;

  it('lists the settings of a topic, the ones set on it first', async () => {
    const run = await setup({ picks: [undefined] });
    run.cluster.overrides.set('topic:orders', new Map([['retention.ms', '1000']]));
    await run.handlers.manageSettings(topicNode);
    expect(run.placeholders[0]).toBe('Settings of the topic "orders"');
    expect(run.lists[0]?.map((one) => one.label)).toEqual([
      'retention.ms = 1000',
      'cleanup.policy = delete',
      'max.message.bytes = 1048588',
    ]);
    expect(run.lists[0]?.[0]?.description).toBe('set here (topic)');
    expect(run.lists[0]?.[1]?.description).toBe('default');
  });

  it('changes a setting after asking and lists them again', async () => {
    const run = await setup({
      picks: [setting('retention.ms'), 'change', undefined],
      inputs: [' 5000 '],
    });
    await run.handlers.manageSettings(topicNode);
    expect(run.cluster.alterCalls).toEqual([
      { key: 'topic:orders', entries: [{ name: 'retention.ms', value: '5000' }] },
    ]);
    expect(run.confirms[0]?.message).toBe('Set "retention.ms" to "5000"?');
    expect(run.infos).toEqual(['"retention.ms" is now 5000']);
    expect(run.lists[2]?.[0]?.label).toBe('retention.ms = 5000');
  });

  it('takes an override away when asked, and offers that only for an override', async () => {
    const run = await setup({ picks: [setting('retention.ms'), 'reset', undefined] });
    run.cluster.overrides.set('topic:orders', new Map([['retention.ms', '1000']]));
    await run.handlers.manageSettings(topicNode);
    expect(run.lists[1]?.map((one) => one.value)).toEqual(['change', 'reset']);
    expect(run.cluster.alterCalls).toEqual([{ key: 'topic:orders', entries: [] }]);
    expect(run.infos).toEqual(['"retention.ms" is back to what it is without an override']);
    const plain = await setup({ picks: [setting('cleanup.policy'), undefined, undefined] });
    await plain.handlers.manageSettings(topicNode);
    expect(plain.lists[1]?.map((one) => one.value)).toEqual(['change']);
  });

  it('says that a setting cannot be changed, and goes on', async () => {
    const run = await setup({
      picks: [
        setting('unclean.leader.election.enable'),
        setting('ssl.keystore.password'),
        undefined,
      ],
    });
    await run.handlers.manageSettings(connectionNode);
    expect(run.infos).toEqual([
      'The setting "unclean.leader.election.enable" cannot be changed',
      'The setting "ssl.keystore.password" is secret; the cluster never tells it, so it is not changed here',
    ]);
    expect(run.cluster.alterCalls).toEqual([]);
    expect(run.lists[0]?.some((one) => one.label.includes('(secret)'))).toBe(true);
  });

  it('works on a broker, asking which when there are several', async () => {
    const run = await setup({
      brokers: 2,
      picks: [pickLabel('Broker 2'), setting('num.io.threads'), 'change', undefined],
      inputs: ['16'],
    });
    await run.handlers.manageSettings(connectionNode);
    expect(run.lists[0]?.map((one) => one.description)).toEqual(['broker1:9092', 'broker2:9092']);
    expect(run.placeholders[1]).toBe('Settings of broker 2');
    expect(run.cluster.alterCalls[0]?.key).toBe('broker:2');
    expect(run.confirms[0]?.detail).toContain('whole broker');
  });

  it('goes straight to the only broker', async () => {
    const run = await setup({ picks: [undefined] });
    await run.handlers.manageSettings(connectionNode);
    expect(run.placeholders).toEqual(['Settings of broker 1']);
  });

  it('backs out at each step without changing anything', async () => {
    const steps: { picks: Answer[]; inputs: (string | undefined)[]; confirm?: boolean }[] = [
      { picks: [setting('retention.ms'), undefined, undefined], inputs: [] },
      { picks: [setting('retention.ms'), 'change', undefined], inputs: [undefined] },
      { picks: [setting('retention.ms'), 'change', undefined], inputs: ['9'], confirm: false },
    ];
    for (const step of steps) {
      const run = await setup({
        picks: step.picks,
        inputs: step.inputs,
        ...(step.confirm === undefined ? {} : { confirm: step.confirm }),
      });
      await run.handlers.manageSettings(topicNode);
      expect(run.cluster.alterCalls).toEqual([]);
    }
    const none = await setup({ picks: [undefined, undefined] });
    await expect(none.handlers.manageSettings(undefined)).resolves.toBeUndefined();
    const gone = await setup({ brokers: 2, picks: [undefined] });
    await gone.handlers.manageSettings(connectionNode);
    expect(gone.lists).toHaveLength(1);
  });

  it('refuses a value that is empty, on a read-only connection, and says production', async () => {
    const empty = await setup({ picks: [setting('retention.ms'), 'change'], inputs: [' '] });
    await expect(empty.handlers.manageSettings(topicNode)).rejects.toThrow(/rejected/u);
    const readOnly = await setup({
      connections: [kafka({ readOnly: true })],
      picks: [setting('retention.ms')],
    });
    await expect(readOnly.handlers.manageSettings(topicNode)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    const production = await setup({
      connections: [kafka({ production: true })],
      picks: [setting('retention.ms'), 'change', undefined],
      inputs: ['7'],
      confirm: false,
    });
    await production.handlers.manageSettings(topicNode);
    expect(production.confirms[0]?.detail).toContain('production connection');
    expect(pickValue('change')([{ label: 'x', value: 'change' }])).toBe('change');
  });
});

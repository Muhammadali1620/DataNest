import { describe, expect, it } from 'vitest';
import type { KafkaAcl } from '../../../../src/drivers/kafka-driver';
import { openKafkaSession } from '../../../../src/drivers/kafka/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeKafka } from '../../../helpers/fake-kafka';

const config: ResolvedConnectionConfig = {
  id: 'k',
  name: 'Kafka',
  driver: 'kafka',
  host: 'broker',
  port: 9092,
};

const open = async (cluster: FakeKafka) => await openKafkaSession(config, cluster.factory);

const alice: KafkaAcl = {
  resource: 'topic',
  name: 'orders',
  pattern: 'literal',
  principal: 'User:alice',
  host: '*',
  operation: 'read',
  permission: 'allow',
};

describe('the brokers and the access rules of a cluster (V13.34)', () => {
  it('lists the brokers by id', async () => {
    const fake = new FakeKafka();
    fake.brokers = 3;
    const brokers = await (await open(fake)).listBrokers();
    expect(brokers).toEqual([
      { id: 1, host: 'broker1', port: 9092 },
      { id: 2, host: 'broker2', port: 9092 },
      { id: 3, host: 'broker3', port: 9092 },
    ]);
  });

  it('starts with no rules, then lists what was made, in order', async () => {
    const session = await open(new FakeKafka());
    expect(await session.listAcls()).toEqual([]);
    const group: KafkaAcl = {
      ...alice,
      resource: 'group',
      name: 'app-',
      pattern: 'prefixed',
      principal: 'User:*',
      operation: 'all',
      permission: 'deny',
    };
    await session.createAcl(group);
    await session.createAcl(alice);
    expect(await session.listAcls()).toEqual([group, alice]);
  });

  it('makes a rule once however many times it is asked', async () => {
    const fake = new FakeKafka();
    const session = await open(fake);
    await session.createAcl(alice);
    await session.createAcl(alice);
    expect(fake.acls).toHaveLength(1);
  });

  it('removes the rule that matches exactly and counts it', async () => {
    const fake = new FakeKafka();
    const session = await open(fake);
    await session.createAcl(alice);
    await session.createAcl({ ...alice, operation: 'write' });
    expect(await session.deleteAcl(alice)).toBe(1);
    expect((await session.listAcls()).map((one) => one.operation)).toEqual(['write']);
    expect(await session.deleteAcl(alice)).toBe(0);
  });

  it('knows every kind of resource and operation', async () => {
    const session = await open(new FakeKafka());
    const resources = ['topic', 'group', 'cluster', 'transactionalId'] as const;
    for (const resource of resources) {
      await session.createAcl({ ...alice, resource, name: `${resource}-x` });
    }
    expect((await session.listAcls()).map((one) => one.resource).sort()).toEqual(
      [...resources].sort(),
    );
    const operations = [
      'all',
      'read',
      'write',
      'create',
      'delete',
      'alter',
      'describe',
      'clusterAction',
      'describeConfigs',
      'alterConfigs',
      'idempotentWrite',
    ] as const;
    for (const operation of operations) {
      await session.createAcl({ ...alice, name: 'ops', operation });
    }
    const found = (await session.listAcls()).filter((one) => one.name === 'ops');
    expect(found.map((one) => one.operation).sort()).toEqual([...operations].sort());
  });

  it('says so when the cluster has no authorizer', async () => {
    const fake = new FakeKafka();
    fake.securityDisabled = true;
    const session = await open(fake);
    await expect(session.listAcls()).rejects.toMatchObject({
      code: 'permission-denied',
      driverCode: 'SECURITY_DISABLED',
    });
    await expect(session.createAcl(alice)).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('reports a rule the cluster would not remove', async () => {
    const fake = new FakeKafka();
    const session = await open(fake);
    await session.createAcl(alice);
    fake.failures.set('deleteAcls', new Error('no'));
    await expect(session.deleteAcl(alice)).rejects.toThrow();
  });
});

describe('the settings of a topic or a broker (V13.34)', () => {
  const topic = { kind: 'topic', name: 'orders' } as const;
  const broker = { kind: 'broker', id: 1 } as const;

  function cluster(): FakeKafka {
    const fake = new FakeKafka();
    fake.addTopic('orders', 1);
    return fake;
  }

  it('lists a topic’s settings by name, saying which are set on the topic', async () => {
    const fake = cluster();
    fake.overrides.set('topic:orders', new Map([['retention.ms', '1000']]));
    const entries = await (await open(fake)).describeConfig(topic);
    expect(entries.map((one) => one.name)).toEqual([
      'cleanup.policy',
      'max.message.bytes',
      'retention.ms',
    ]);
    const retention = entries.find((one) => one.name === 'retention.ms');
    expect(retention).toMatchObject({ value: '1000', overridden: true, source: 'topic' });
    const policy = entries.find((one) => one.name === 'cleanup.policy');
    expect(policy).toMatchObject({ value: 'delete', overridden: false, source: 'default' });
  });

  it('lists a broker’s settings: static and dynamic, secret and read-only marked', async () => {
    const fake = cluster();
    fake.overrides.set('broker:1', new Map([['num.io.threads', '12']]));
    const entries = await (await open(fake)).describeConfig(broker);
    expect(entries.find((one) => one.name === 'num.io.threads')).toMatchObject({
      value: '12',
      overridden: true,
      source: 'dynamic broker',
    });
    expect(entries.find((one) => one.name === 'log.retention.hours')).toMatchObject({
      overridden: false,
      source: 'static',
    });
    expect(entries.find((one) => one.name === 'ssl.keystore.password')).toMatchObject({
      sensitive: true,
      value: '',
    });
    expect(entries.find((one) => one.name === 'unclean.leader.election.enable')?.readOnly).toBe(
      true,
    );
  });

  it('says a topic is missing', async () => {
    await expect(
      (await open(cluster())).describeConfig({ kind: 'topic', name: 'nope' }),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('sets one setting and keeps the ones that were already set', async () => {
    const fake = cluster();
    fake.overrides.set('topic:orders', new Map([['retention.ms', '1000']]));
    const session = await open(fake);
    await session.setConfig(topic, 'max.message.bytes', '2048');
    expect(fake.alterCalls.at(-1)?.entries).toEqual([
      { name: 'retention.ms', value: '1000' },
      { name: 'max.message.bytes', value: '2048' },
    ]);
    const entries = await session.describeConfig(topic);
    expect(entries.find((one) => one.name === 'retention.ms')?.value).toBe('1000');
    expect(entries.find((one) => one.name === 'max.message.bytes')?.value).toBe('2048');
  });

  it('changes a setting that was already set, once', async () => {
    const fake = cluster();
    fake.overrides.set('topic:orders', new Map([['retention.ms', '1000']]));
    await (await open(fake)).setConfig(topic, 'retention.ms', '5');
    expect(fake.alterCalls.at(-1)?.entries).toEqual([{ name: 'retention.ms', value: '5' }]);
  });

  it('takes an override away with null and leaves the others alone', async () => {
    const fake = cluster();
    fake.overrides.set(
      'topic:orders',
      new Map([
        ['retention.ms', '1000'],
        ['cleanup.policy', 'compact'],
      ]),
    );
    const session = await open(fake);
    await session.setConfig(topic, 'retention.ms', null);
    expect(fake.alterCalls.at(-1)?.entries).toEqual([{ name: 'cleanup.policy', value: 'compact' }]);
    const entries = await session.describeConfig(topic);
    expect(entries.find((one) => one.name === 'retention.ms')).toMatchObject({
      overridden: false,
      value: '604800000',
    });
  });

  it('changes a broker the same way', async () => {
    const fake = cluster();
    await (await open(fake)).setConfig(broker, 'num.io.threads', '16');
    expect(fake.alterCalls.at(-1)).toEqual({
      key: 'broker:1',
      entries: [{ name: 'num.io.threads', value: '16' }],
    });
  });

  it('refuses a setting that does not exist or may not be changed', async () => {
    const session = await open(cluster());
    await expect(session.setConfig(topic, 'no.such', '1')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(
      session.setConfig(broker, 'unclean.leader.election.enable', 'true'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses to change a broker that holds a secret setting, which would be lost', async () => {
    const fake = cluster();
    fake.overrides.set('broker:1', new Map([['ssl.keystore.password', 'x']]));
    const session = await open(fake);
    await expect(session.setConfig(broker, 'num.io.threads', '2')).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(fake.alterCalls).toHaveLength(0);
  });
});

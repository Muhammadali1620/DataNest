import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/kafka';
import type { KafkaAcl, KafkaSession } from '../../../src/drivers/kafka-driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TEST_KAFKA } from '../../helpers/kafka-servers';

// docker/compose.yml `kafka` (V13.34): the authorizer is on and the plain listener's
// anonymous user is a super user, so the tests make rules for other users.
const config: ResolvedConnectionConfig = {
  id: 'test-kafka-admin',
  name: 'Kafka',
  driver: 'kafka',
  host: TEST_KAFKA.host,
  port: TEST_KAFKA.port,
};

const unique = (name: string): string => `dn-it-${name}-${randomUUID().slice(0, 8)}`;

describe('Kafka access rules and settings (V13.34)', () => {
  let session: KafkaSession;
  const topics: string[] = [];
  const principal = `User:${unique('user')}`;

  beforeAll(async () => {
    session = await driver.openSession(config);
  }, 60_000);

  afterAll(async () => {
    for (const name of topics) {
      await session.deleteTopic(name).catch(() => undefined);
    }
    await session.close();
  });

  it('lists the brokers', async () => {
    const brokers = await session.listBrokers();
    expect(brokers).toHaveLength(1);
    expect(brokers[0]).toMatchObject({ id: 1, port: 7092 });
  });

  it('makes, lists and removes rules on the real cluster', async () => {
    const name = unique('acl-topic');
    const read: KafkaAcl = {
      resource: 'topic',
      name,
      pattern: 'literal',
      principal,
      host: '*',
      operation: 'read',
      permission: 'allow',
    };
    const deny: KafkaAcl = {
      ...read,
      name: 'acl-',
      pattern: 'prefixed',
      operation: 'write',
      permission: 'deny',
    };
    await session.createAcl(read);
    await session.createAcl(deny);
    const mine = (await session.listAcls()).filter((one) => one.principal === principal);
    expect(mine).toEqual(expect.arrayContaining([read, deny]));
    expect(mine).toHaveLength(2);
    expect(await session.deleteAcl(read)).toBe(1);
    expect(await session.deleteAcl(deny)).toBe(1);
    expect((await session.listAcls()).filter((one) => one.principal === principal)).toEqual([]);
    expect(await session.deleteAcl(read)).toBe(0);
  });

  it('keeps working for the super user once rules for others exist', async () => {
    const name = unique('acl-effect');
    await session.createTopic(name, 1, 1);
    topics.push(name);
    const rule: KafkaAcl = {
      resource: 'topic',
      name,
      pattern: 'literal',
      principal: 'User:nobody',
      host: '*',
      operation: 'read',
      permission: 'allow',
    };
    await session.createAcl(rule);
    const messages = await session.readMessages({
      topic: name,
      partition: 0,
      count: 1,
      maxBytes: 1000,
    });
    expect(messages).toEqual([]);
    await session.deleteAcl(rule);
  });

  it('shows a topic’s settings and changes one without losing another', async () => {
    const name = unique('config');
    await session.createTopic(name, 1, 1);
    topics.push(name);
    const target = { kind: 'topic', name } as const;
    const before = await session.describeConfig(target);
    expect(before.find((one) => one.name === 'retention.ms')).toMatchObject({ overridden: false });
    await session.setConfig(target, 'retention.ms', '3600000');
    await session.setConfig(target, 'cleanup.policy', 'compact');
    const after = await session.describeConfig(target);
    expect(after.find((one) => one.name === 'retention.ms')).toMatchObject({
      value: '3600000',
      overridden: true,
      source: 'topic',
    });
    expect(after.find((one) => one.name === 'cleanup.policy')).toMatchObject({
      value: 'compact',
      overridden: true,
    });
    await session.setConfig(target, 'retention.ms', null);
    const reset = await session.describeConfig(target);
    expect(reset.find((one) => one.name === 'retention.ms')).toMatchObject({ overridden: false });
    expect(reset.find((one) => one.name === 'cleanup.policy')).toMatchObject({
      value: 'compact',
      overridden: true,
    });
  });

  it('refuses a setting the topic has not, and a value the cluster does not accept', async () => {
    const name = unique('config-bad');
    await session.createTopic(name, 1, 1);
    topics.push(name);
    const target = { kind: 'topic', name } as const;
    await expect(session.setConfig(target, 'no.such.setting', '1')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(session.setConfig(target, 'retention.ms', 'soon')).rejects.toThrow();
  });

  it('shows a broker’s settings', async () => {
    const entries = await session.describeConfig({ kind: 'broker', id: 1 });
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.find((one) => one.name === 'log.retention.hours')).toBeDefined();
    expect(entries.every((one) => one.source !== 'unknown')).toBe(true);
  });

  it('changes a dynamic broker setting and puts it back', async () => {
    const target = { kind: 'broker', id: 1 } as const;
    const key = 'log.cleaner.threads';
    const before = (await session.describeConfig(target)).find((one) => one.name === key);
    expect(before?.overridden).toBe(false);
    await session.setConfig(target, key, '2');
    const changed = (await session.describeConfig(target)).find((one) => one.name === key);
    expect(changed).toMatchObject({ value: '2', overridden: true });
    await session.setConfig(target, key, null);
    const back = (await session.describeConfig(target)).find((one) => one.name === key);
    expect(back?.overridden).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeKafkaDriver } from '../../helpers/fake-kafka';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { FakeTunnels } from '../../helpers/fake-tunnels';

describe('ConnectionManager with Kafka (V13.23)', () => {
  async function setup() {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const kafka = new FakeKafkaDriver();
    kafka.cluster.addTopic('orders', 1);
    const tunnels = new FakeTunnels();
    const manager = new ConnectionManager({
      store,
      drivers: Object.assign(new FakeDriverProvider(), { getKafka: () => Promise.resolve(kafka) }),
      logger,
      tunnels,
      checkHostKey: () => Promise.resolve(true),
    });
    const cluster = await store.add(
      {
        name: 'Cluster',
        driver: 'kafka',
        host: 'b1:9092,b2',
        user: 'bob',
        kafka: { sasl: 'scram-sha-256' },
      },
      'pw',
    );
    return { store, kafka, manager, cluster, tunnels };
  }

  it('opens a session with the stored password and keeps the families apart', async () => {
    const { manager, kafka, cluster, store } = await setup();
    const session = await manager.acquireKafka('tree:x', { connectionId: cluster.id });
    expect(kafka.configs[0]).toMatchObject({
      host: 'b1:9092,b2',
      user: 'bob',
      password: 'pw',
      kafka: { sasl: 'scram-sha-256' },
    });
    expect(manager.kafkaSessionOf('tree:x')).toBe(session);
    expect(manager.etcdSessionOf('tree:x')).toBeUndefined();
    expect(manager.familyOf(cluster.id)).toBe('kafka');
    expect(await session.listTopics()).toEqual([{ name: 'orders', internal: false }]);
    await expect(manager.acquire('a', { connectionId: cluster.id })).rejects.toMatchObject({
      message: expect.stringContaining('Kafka connection') as unknown,
    });
    const sql = await store.add({ name: 'Db', driver: 'mysql', host: 'h' });
    await expect(manager.acquireKafka('b', { connectionId: sql.id })).rejects.toMatchObject({
      message: expect.stringContaining('not a Kafka connection') as unknown,
    });
    await expect(manager.driverOf(cluster.id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('shares the session of an owner and gives another owner its own', async () => {
    const { manager, kafka, cluster } = await setup();
    const first = await manager.acquireKafka('a', { connectionId: cluster.id });
    expect(await manager.acquireKafka('a', { connectionId: cluster.id })).toBe(first);
    await manager.acquireKafka('b', { connectionId: cluster.id });
    expect(kafka.sessions).toHaveLength(2);
  });

  it('connects the tree, drops a lost session and closes all on disconnect', async () => {
    const { manager, kafka, cluster } = await setup();
    await manager.connectAny(cluster.id);
    expect(manager.getState(cluster.id).status).toBe('connected');
    const tree = manager.kafkaSessionOf(ConnectionManager.treeOwner(cluster.id));
    expect(tree).toBeDefined();
    kafka.cluster.failures.set('listTopics', new DbError('connection-failed', 'link lost'));
    await expect(tree?.listTopics()).rejects.toMatchObject({ code: 'connection-failed' });
    expect(manager.kafkaSessionOf(ConnectionManager.treeOwner(cluster.id))).toBeUndefined();
    await manager.acquireKafka('a', { connectionId: cluster.id });
    await manager.disconnect(cluster.id);
    expect(kafka.sessions.every((entry) => entry.closed)).toBe(true);
    expect(manager.getState(cluster.id).status).toBe('disconnected');
  });

  it('reports a failed connection as an error state', async () => {
    const { manager, kafka, cluster } = await setup();
    kafka.failure = new DbError('auth-failed', 'wrong password');
    await expect(manager.connectAny(cluster.id)).rejects.toMatchObject({ code: 'auth-failed' });
    expect(manager.getState(cluster.id)).toMatchObject({
      status: 'error',
      error: 'wrong password',
    });
  });

  it('refuses a disabled connection', async () => {
    const { manager, cluster, store } = await setup();
    await store.setDisabled(cluster.id, true);
    await expect(manager.acquireKafka('a', { connectionId: cluster.id })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('goes through an SSH tunnel and tests settings with a throwaway session', async () => {
    const { manager, kafka, store, tunnels } = await setup();
    const tunnelled = await store.add({
      name: 'T',
      driver: 'kafka',
      host: 'kafka.internal',
      ssh: { id: 'b', host: 'bastion', user: 'u', auth: 'agent' },
    });
    await manager.acquireKafka('a', { connectionId: tunnelled.id });
    expect(kafka.configs[0]).toMatchObject({
      host: '127.0.0.1',
      port: 40_000,
      tlsServerName: 'kafka.internal',
    });
    await manager.disconnect(tunnelled.id);
    expect(tunnels.released).toHaveLength(1);
    await manager.test({ name: 't', driver: 'kafka', host: 'h' }, 'secret');
    expect(kafka.configs.at(-1)).toMatchObject({ id: 'test', password: 'secret' });
    expect(kafka.sessions.at(-1)?.closed).toBe(true);
    kafka.failure = new DbError('auth-failed', 'no');
    await expect(manager.test({ name: 't', driver: 'kafka', host: 'h' })).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('says Kafka is not available without the driver', async () => {
    const { store, cluster } = await setup();
    const plain = new ConnectionManager({
      store,
      drivers: new FakeDriverProvider(),
      logger: new RecordingLogger(),
    });
    await expect(plain.acquireKafka('a', { connectionId: cluster.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(plain.test({ name: 't', driver: 'kafka', host: 'h' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('ConnectionStore with Kafka', () => {
  function store() {
    return new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
  }

  it('drops the database a Kafka connection cannot have, and keeps the brokers', async () => {
    const saved = await store().add({
      name: 'k',
      driver: 'kafka',
      host: ' a:1,b:2 ',
      database: 'x',
    });
    expect(saved.database).toBeUndefined();
    expect(saved.host).toBe('a:1,b:2');
  });

  it('keeps the SASL mechanism, and leaves out "none" as the default', async () => {
    const s = store();
    const plain = await s.add({ name: 'p', driver: 'kafka', host: 'h', kafka: { sasl: 'plain' } });
    expect(plain.kafka).toEqual({ sasl: 'plain' });
    const none = await s.add({ name: 'n', driver: 'kafka', host: 'h', kafka: { sasl: 'none' } });
    expect(none.kafka).toBeUndefined();
  });

  it('forgets the SASL mechanism of a connection that is not Kafka', async () => {
    const saved = await store().add({
      name: 'm',
      driver: 'mysql',
      host: 'h',
      kafka: { sasl: 'plain' },
    });
    expect(saved.kafka).toBeUndefined();
  });
});

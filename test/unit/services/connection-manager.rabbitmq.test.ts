import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeRabbitDriver } from '../../helpers/fake-rabbitmq';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { FakeTunnels } from '../../helpers/fake-tunnels';

describe('ConnectionManager with RabbitMQ (V13.26)', () => {
  async function setup() {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const rabbit = new FakeRabbitDriver();
    rabbit.session.broker.addQueue({ vhost: '/', name: 'orders' });
    const tunnels = new FakeTunnels();
    const manager = new ConnectionManager({
      store,
      drivers: Object.assign(new FakeDriverProvider(), {
        getRabbit: () => Promise.resolve(rabbit),
      }),
      logger,
      tunnels,
      checkHostKey: () => Promise.resolve(true),
    });
    const broker = await store.add(
      { name: 'Broker', driver: 'rabbitmq', host: 'mq', user: 'bob', database: 'app' },
      'pw',
    );
    return { store, rabbit, manager, broker, tunnels };
  }

  it('opens a session with the stored password and keeps the families apart', async () => {
    const { manager, rabbit, broker, store } = await setup();
    const session = await manager.acquireRabbit('tree:x', { connectionId: broker.id });
    expect(rabbit.configs[0]).toMatchObject({
      host: 'mq',
      user: 'bob',
      password: 'pw',
      database: 'app',
    });
    expect(manager.rabbitSessionOf('tree:x')).toBe(session);
    expect(manager.kafkaSessionOf('tree:x')).toBeUndefined();
    expect(manager.familyOf(broker.id)).toBe('rabbitmq');
    await expect(manager.acquire('a', { connectionId: broker.id })).rejects.toMatchObject({
      message: expect.stringContaining('RabbitMQ connection') as unknown,
    });
    const sql = await store.add({ name: 'Db', driver: 'mysql', host: 'h' });
    await expect(manager.acquireRabbit('b', { connectionId: sql.id })).rejects.toMatchObject({
      message: expect.stringContaining('not a RabbitMQ connection') as unknown,
    });
    await expect(manager.driverOf(broker.id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('keeps the virtual host of the connection: a RabbitMQ connection has one', async () => {
    const { store } = await setup();
    const saved = await store.add({
      name: 'r',
      driver: 'rabbitmq',
      host: ' mq ',
      database: ' / ',
    });
    expect(saved.host).toBe('mq');
    expect(saved.database).toBe('/');
  });

  it('shares the session of an owner and gives another owner the same fake one', async () => {
    const { manager, broker } = await setup();
    const first = await manager.acquireRabbit('a', { connectionId: broker.id });
    expect(await manager.acquireRabbit('a', { connectionId: broker.id })).toBe(first);
  });

  it('connects the tree, drops a lost session and closes all on disconnect', async () => {
    const { manager, rabbit, broker } = await setup();
    await manager.connectAny(broker.id);
    expect(manager.getState(broker.id).status).toBe('connected');
    const tree = manager.rabbitSessionOf(ConnectionManager.treeOwner(broker.id));
    expect(tree).toBeDefined();
    rabbit.session.failures.set('listVhosts', new DbError('connection-failed', 'link lost'));
    await expect(tree?.listVhosts()).rejects.toMatchObject({ code: 'connection-failed' });
    expect(manager.rabbitSessionOf(ConnectionManager.treeOwner(broker.id))).toBeUndefined();
    await manager.acquireRabbit('a', { connectionId: broker.id });
    await manager.disconnect(broker.id);
    expect(rabbit.session.closed).toBe(true);
    expect(manager.getState(broker.id).status).toBe('disconnected');
  });

  it('reports a failed connection as an error state', async () => {
    const { manager, rabbit, broker } = await setup();
    rabbit.openError = new DbError('auth-failed', 'wrong password');
    await expect(manager.connectAny(broker.id)).rejects.toMatchObject({ code: 'auth-failed' });
    expect(manager.getState(broker.id)).toMatchObject({
      status: 'error',
      error: 'wrong password',
    });
  });

  it('refuses a disabled connection', async () => {
    const { manager, broker, store } = await setup();
    await store.setDisabled(broker.id, true);
    await expect(manager.acquireRabbit('a', { connectionId: broker.id })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('goes through an SSH tunnel and tests settings with a throwaway session', async () => {
    const { manager, rabbit, store, tunnels } = await setup();
    const tunnelled = await store.add({
      name: 'T',
      driver: 'rabbitmq',
      host: 'mq.internal',
      ssh: { id: 'b', host: 'bastion', user: 'u', auth: 'agent' },
    });
    await manager.acquireRabbit('a', { connectionId: tunnelled.id });
    expect(rabbit.configs[0]).toMatchObject({
      host: '127.0.0.1',
      port: 40_000,
      tlsServerName: 'mq.internal',
    });
    await manager.disconnect(tunnelled.id);
    expect(tunnels.released).toHaveLength(1);
    rabbit.session.closed = false;
    await manager.test({ name: 't', driver: 'rabbitmq', host: 'h' }, 'secret');
    expect(rabbit.configs.at(-1)).toMatchObject({ id: 'test', password: 'secret' });
    expect(rabbit.session.closed).toBe(true);
    rabbit.openError = new DbError('auth-failed', 'no');
    await expect(manager.test({ name: 't', driver: 'rabbitmq', host: 'h' })).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('says RabbitMQ is not available without the driver', async () => {
    const { store, broker } = await setup();
    const plain = new ConnectionManager({
      store,
      drivers: new FakeDriverProvider(),
      logger: new RecordingLogger(),
    });
    await expect(plain.acquireRabbit('a', { connectionId: broker.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(plain.test({ name: 't', driver: 'rabbitmq', host: 'h' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

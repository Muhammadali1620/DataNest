import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { FakeTunnels } from '../../helpers/fake-tunnels';
import { FakeZookeeperDriver } from '../../helpers/fake-zookeeper-driver';

describe('ConnectionManager with ZooKeeper (V13.24)', () => {
  async function setup() {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const zookeeper = new FakeZookeeperDriver();
    const tunnels = new FakeTunnels();
    const manager = new ConnectionManager({
      store,
      drivers: Object.assign(new FakeDriverProvider(), {
        getZookeeper: () => Promise.resolve(zookeeper),
      }),
      logger,
      tunnels,
      checkHostKey: () => Promise.resolve(true),
    });
    const ensemble = await store.add(
      { name: 'Ensemble', driver: 'zookeeper', host: 'h', user: 'alice', database: '/app' },
      'pw',
    );
    return { store, zookeeper, manager, ensemble, tunnels };
  }

  it('opens a session with the stored password and the chroot, and keeps the families apart', async () => {
    const { manager, zookeeper, ensemble, store } = await setup();
    const session = await manager.acquireZookeeper('tree:x', { connectionId: ensemble.id });
    expect(zookeeper.configs[0]).toMatchObject({
      host: 'h',
      user: 'alice',
      password: 'pw',
      database: '/app',
    });
    expect(manager.zookeeperSessionOf('tree:x')).toBe(session);
    expect(manager.etcdSessionOf('tree:x')).toBeUndefined();
    expect(manager.familyOf(ensemble.id)).toBe('zookeeper');
    await expect(manager.acquire('a', { connectionId: ensemble.id })).rejects.toMatchObject({
      message: expect.stringContaining('ZooKeeper connection') as unknown,
    });
    const sql = await store.add({ name: 'Db', driver: 'mysql', host: 'h' });
    await expect(manager.acquireZookeeper('b', { connectionId: sql.id })).rejects.toMatchObject({
      message: expect.stringContaining('not a ZooKeeper connection') as unknown,
    });
    await expect(manager.driverOf(ensemble.id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('shares the session of an owner and gives another owner its own', async () => {
    const { manager, zookeeper, ensemble } = await setup();
    const first = await manager.acquireZookeeper('a', { connectionId: ensemble.id });
    expect(await manager.acquireZookeeper('a', { connectionId: ensemble.id })).toBe(first);
    await manager.acquireZookeeper('b', { connectionId: ensemble.id });
    expect(zookeeper.sessions).toHaveLength(2);
  });

  it('connects the tree, drops a lost session and closes all on disconnect', async () => {
    const { manager, zookeeper, ensemble } = await setup();
    await manager.connectAny(ensemble.id);
    expect(manager.getState(ensemble.id).status).toBe('connected');
    const tree = manager.zookeeperSessionOf(ConnectionManager.treeOwner(ensemble.id));
    expect(tree).toBeDefined();
    await zookeeper.sessions[0]?.close();
    await expect(tree?.exists('/')).rejects.toMatchObject({ code: 'connection-failed' });
    expect(manager.zookeeperSessionOf(ConnectionManager.treeOwner(ensemble.id))).toBeUndefined();
    await manager.acquireZookeeper('a', { connectionId: ensemble.id });
    await manager.disconnect(ensemble.id);
    expect(zookeeper.sessions.every((session) => session.closed)).toBe(true);
    expect(manager.getState(ensemble.id).status).toBe('disconnected');
  });

  it('reports a failed connection as an error state', async () => {
    const { manager, zookeeper, ensemble } = await setup();
    zookeeper.failure = new DbError('auth-failed', 'wrong password');
    await expect(manager.connectAny(ensemble.id)).rejects.toMatchObject({ code: 'auth-failed' });
    expect(manager.getState(ensemble.id)).toMatchObject({
      status: 'error',
      error: 'wrong password',
    });
  });

  it('refuses a disabled connection', async () => {
    const { manager, ensemble, store } = await setup();
    await store.setDisabled(ensemble.id, true);
    await expect(
      manager.acquireZookeeper('a', { connectionId: ensemble.id }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('goes through an SSH tunnel and tests settings with a throwaway session', async () => {
    const { manager, zookeeper, store, tunnels } = await setup();
    const tunnelled = await store.add({
      name: 'T',
      driver: 'zookeeper',
      host: 'zk.internal',
      ssh: { id: 'b', host: 'bastion', user: 'u', auth: 'agent' },
    });
    await manager.acquireZookeeper('a', { connectionId: tunnelled.id });
    expect(zookeeper.configs[0]).toMatchObject({
      host: '127.0.0.1',
      port: 40_000,
      tlsServerName: 'zk.internal',
    });
    await manager.disconnect(tunnelled.id);
    expect(tunnels.released).toHaveLength(1);
    await manager.test({ name: 't', driver: 'zookeeper', host: 'h' }, 'secret');
    expect(zookeeper.configs.at(-1)).toMatchObject({ id: 'test', password: 'secret' });
    expect(zookeeper.sessions.at(-1)?.closed).toBe(true);
    zookeeper.failure = new DbError('auth-failed', 'no');
    await expect(manager.test({ name: 't', driver: 'zookeeper', host: 'h' })).rejects.toMatchObject(
      { code: 'auth-failed' },
    );
  });

  it('says ZooKeeper is not available without the driver', async () => {
    const { store, ensemble } = await setup();
    const plain = new ConnectionManager({
      store,
      drivers: new FakeDriverProvider(),
      logger: new RecordingLogger(),
    });
    await expect(plain.acquireZookeeper('a', { connectionId: ensemble.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(plain.test({ name: 't', driver: 'zookeeper', host: 'h' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

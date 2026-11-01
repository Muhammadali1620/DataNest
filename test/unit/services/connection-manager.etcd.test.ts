import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeEtcdDriver } from '../../helpers/fake-etcd';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { FakeTunnels } from '../../helpers/fake-tunnels';

describe('ConnectionManager with etcd (V13.19)', () => {
  async function setup() {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const etcd = new FakeEtcdDriver();
    const tunnels = new FakeTunnels();
    const manager = new ConnectionManager({
      store,
      drivers: Object.assign(new FakeDriverProvider(), { getEtcd: () => Promise.resolve(etcd) }),
      logger,
      tunnels,
      checkHostKey: () => Promise.resolve(true),
    });
    const cluster = await store.add(
      { name: 'Cluster', driver: 'etcd', host: 'h', user: 'root' },
      'pw',
    );
    return { store, etcd, manager, cluster, tunnels };
  }

  it('opens a session with the stored password and keeps the families apart', async () => {
    const { manager, etcd, cluster, store } = await setup();
    const session = await manager.acquireEtcd('tree:x', { connectionId: cluster.id });
    expect(etcd.configs[0]).toMatchObject({ host: 'h', user: 'root', password: 'pw' });
    expect(manager.etcdSessionOf('tree:x')).toBe(session);
    expect(manager.elasticSessionOf('tree:x')).toBeUndefined();
    expect(manager.familyOf(cluster.id)).toBe('etcd');
    await expect(manager.acquire('a', { connectionId: cluster.id })).rejects.toMatchObject({
      message: expect.stringContaining('etcd connection') as unknown,
    });
    const sql = await store.add({ name: 'Db', driver: 'mysql', host: 'h' });
    await expect(manager.acquireEtcd('b', { connectionId: sql.id })).rejects.toMatchObject({
      message: expect.stringContaining('not an etcd connection') as unknown,
    });
    await expect(manager.driverOf(cluster.id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('shares the session of an owner and gives another owner its own', async () => {
    const { manager, etcd, cluster } = await setup();
    const first = await manager.acquireEtcd('a', { connectionId: cluster.id });
    expect(await manager.acquireEtcd('a', { connectionId: cluster.id })).toBe(first);
    await manager.acquireEtcd('b', { connectionId: cluster.id });
    expect(etcd.sessions).toHaveLength(2);
  });

  it('connects the tree, drops a lost session and closes all on disconnect', async () => {
    const { manager, etcd, cluster } = await setup();
    await manager.connectAny(cluster.id);
    expect(manager.getState(cluster.id).status).toBe('connected');
    const tree = manager.etcdSessionOf(ConnectionManager.treeOwner(cluster.id));
    expect(tree).toBeDefined();
    await etcd.sessions[0]?.close();
    await expect(tree?.call('kv/range', { key: 'YQ==' })).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(manager.etcdSessionOf(ConnectionManager.treeOwner(cluster.id))).toBeUndefined();
    await manager.acquireEtcd('a', { connectionId: cluster.id });
    await manager.disconnect(cluster.id);
    expect(etcd.sessions.every((session) => session.closed)).toBe(true);
    expect(manager.getState(cluster.id).status).toBe('disconnected');
  });

  it('reports a failed connection as an error state', async () => {
    const { manager, etcd, cluster } = await setup();
    etcd.failure = new DbError('auth-failed', 'wrong password');
    await expect(manager.connectAny(cluster.id)).rejects.toMatchObject({ code: 'auth-failed' });
    expect(manager.getState(cluster.id)).toMatchObject({
      status: 'error',
      error: 'wrong password',
    });
  });

  it('refuses a disabled connection', async () => {
    const { manager, cluster, store } = await setup();
    await store.setDisabled(cluster.id, true);
    await expect(manager.acquireEtcd('a', { connectionId: cluster.id })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('goes through an SSH tunnel and tests settings with a throwaway session', async () => {
    const { manager, etcd, store, tunnels } = await setup();
    const tunnelled = await store.add({
      name: 'T',
      driver: 'etcd',
      host: 'etcd.internal',
      ssh: { id: 'b', host: 'bastion', user: 'u', auth: 'agent' },
    });
    await manager.acquireEtcd('a', { connectionId: tunnelled.id });
    expect(etcd.configs[0]).toMatchObject({
      host: '127.0.0.1',
      port: 40_000,
      tlsServerName: 'etcd.internal',
    });
    await manager.disconnect(tunnelled.id);
    expect(tunnels.released).toHaveLength(1);
    await manager.test({ name: 't', driver: 'etcd', host: 'h' }, 'secret');
    expect(etcd.configs.at(-1)).toMatchObject({ id: 'test', password: 'secret' });
    expect(etcd.sessions.at(-1)?.closed).toBe(true);
    etcd.failure = new DbError('auth-failed', 'no');
    await expect(manager.test({ name: 't', driver: 'etcd', host: 'h' })).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('says etcd is not available without the driver', async () => {
    const { store, cluster } = await setup();
    const plain = new ConnectionManager({
      store,
      drivers: new FakeDriverProvider(),
      logger: new RecordingLogger(),
    });
    await expect(plain.acquireEtcd('a', { connectionId: cluster.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(plain.test({ name: 't', driver: 'etcd', host: 'h' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

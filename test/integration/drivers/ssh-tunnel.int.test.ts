// SSH tunnels against a real OpenSSH server (docker/compose.yml, service `ssh`):
// the databases are reached by their names inside the compose network, which only
// the SSH server can resolve, so every query below really went through the tunnel.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { ssh } from '../../../src/services/ssh';
import { type HostKeyInfo, TunnelPool } from '../../../src/services/tunnels';
import type { ConnectionInput, DriverId, SshHop } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId, testSshServer } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { startTestAgent } from '../../helpers/ssh-server';

const server = testSshServer();

async function rows(manager: ConnectionManager, owner: string, id: string, sql: string) {
  const session = await manager.acquire(owner, { connectionId: id });
  const result: unknown[][] = [];
  for await (const event of session.execute(sql)) {
    if (event.kind === 'rows') {
      result.push(...event.rows.map((row) => [...row]));
    }
  }
  return result;
}

const DRIVERS: Readonly<Record<'mysql' | 'postgres', Driver>> = {
  mysql: mysqlDriver,
  postgres: postgresDriver,
};

const TARGETS: readonly { id: TestDatabaseId; driver: 'mysql' | 'postgres' }[] = [
  { id: 'mysql', driver: 'mysql' },
  { id: 'mariadb', driver: 'mysql' },
  { id: 'postgres', driver: 'postgres' },
];

describe('SSH tunnel to real databases', () => {
  const logger = new RecordingLogger();
  const seenKeys: HostKeyInfo[] = [];
  let store: ConnectionStore;
  let pool: TunnelPool;
  let manager: ConnectionManager;

  function input(id: TestDatabaseId, driver: DriverId, hop: Partial<SshHop> = {}): ConnectionInput {
    const db = testDatabase(id);
    const target = server.targets[id];
    return {
      name: `${id} via ssh`,
      driver,
      host: target.host,
      port: target.port,
      user: db.user,
      database: db.database,
      ssh: {
        id: 'main',
        host: server.host,
        port: server.port,
        user: server.user,
        auth: 'password',
        ...hop,
      },
    };
  }

  beforeAll(() => {
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    pool = new TunnelPool({ load: () => Promise.resolve(ssh), logger });
    manager = new ConnectionManager({
      store,
      drivers: { get: (id) => Promise.resolve(DRIVERS[id as 'mysql' | 'postgres']) },
      logger,
      tunnels: pool,
      checkHostKey: (key) => {
        seenKeys.push(key);
        return Promise.resolve(true);
      },
    });
  });

  afterEach(async () => {
    for (const config of store.list()) {
      await manager.disconnect(config.id);
    }
  });

  afterAll(() => {
    manager.dispose();
    pool.dispose();
  });

  it.each(TARGETS)(
    'queries $id through the tunnel with an SSH password',
    async ({ id, driver }) => {
      const config = await store.add(input(id, driver), 'datanest', {
        main: { password: server.password },
      });
      expect(await rows(manager, 'editor:a', config.id, 'SELECT 41 + 1')).toEqual([[42]]);
      expect(pool.size).toBe(1);
    },
  );

  it('shares one tunnel between sessions and closes it with the last one', async () => {
    const config = await store.add(input('postgres', 'postgres'), 'datanest', {
      main: { password: server.password },
    });
    await rows(manager, 'editor:a', config.id, 'SELECT 1');
    await rows(manager, 'editor:b', config.id, 'SELECT 2');
    expect(pool.size).toBe(1);
    await manager.release('editor:a');
    expect(pool.size).toBe(1);
    await manager.release('editor:b');
    expect(pool.size).toBe(0);
  });

  it('cancels a running statement through the tunnel', async () => {
    const config = await store.add(input('postgres', 'postgres'), 'datanest', {
      main: { password: server.password },
    });
    const session = await manager.acquire('editor:c', { connectionId: config.id });
    const events = session.execute('SELECT pg_sleep(30)');
    const run = (async () => {
      for await (const _event of events) {
        // Waiting for the cancel.
      }
    })();
    const cancelled = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel();
    await cancelled;
  });

  it('logs in with the encrypted key and its passphrase', async () => {
    const config = await store.add(
      input('mysql', 'mysql', { auth: 'key', keyFile: server.keyFile }),
      'datanest',
      { main: { passphrase: server.passphrase } },
    );
    expect(await rows(manager, 'editor:a', config.id, 'SELECT 7')).toEqual([[7]]);
  });

  it('logs in through an SSH agent that holds the key', async () => {
    const agent = await startTestAgent(readFileSync(server.keyFile), server.passphrase);
    try {
      const config = await store.add(
        input('postgres', 'postgres', { auth: 'agent', agentSocket: agent.socket }),
        'datanest',
      );
      expect(await rows(manager, 'editor:a', config.id, 'SELECT 8')).toEqual([[8]]);
    } finally {
      await agent.close();
    }
  });

  it('shows the real server key to the host key check', () => {
    const key = seenKeys.find((entry) => entry.port === server.port);
    expect(key?.algorithm).toMatch(/^(ssh-ed25519|rsa-sha2-512|rsa-sha2-256|ecdsa-sha2-nistp256)$/);
    expect(key?.fingerprint).toMatch(/^SHA256:/);
  });

  it('reports a wrong SSH password as a failed login', async () => {
    const config = await store.add(input('mysql', 'mysql'), 'datanest', {
      main: { password: 'wrong' },
    });
    await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      code: 'auth-failed',
      message: expect.stringContaining('SSH login failed') as unknown,
    });
    expect(pool.size).toBe(0);
  });

  it('explains a database the SSH server cannot reach', async () => {
    const config = await store.add(
      { ...input('mysql', 'mysql'), host: 'no-such-db', port: 3306 },
      'datanest',
      { main: { password: server.password } },
    );
    await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('cannot reach no-such-db:3306') as unknown,
    });
  });

  describe('through a jump host', () => {
    function deep(id: TestDatabaseId, driver: DriverId, jumps: SshHop[]): ConnectionInput {
      const base = input(id, driver);
      return {
        ...base,
        ssh: {
          id: 'main',
          host: server.inner.host,
          port: server.inner.port,
          user: server.user,
          auth: 'key',
          keyFile: server.keyFile,
          jumps,
        },
      };
    }

    const edge: SshHop = {
      id: 'edge',
      host: server.host,
      port: server.port,
      user: server.user,
      auth: 'password',
    };

    it.each(TARGETS)('queries $id through two SSH servers', async ({ id, driver }) => {
      const config = await store.add(deep(id, driver, [edge]), 'datanest', {
        edge: { password: server.password },
        main: { passphrase: server.passphrase },
      });
      expect(await rows(manager, 'editor:a', config.id, 'SELECT 5')).toEqual([[5]]);
      // The inner server has no port on this machine: only the jump host could reach it.
      expect(seenKeys.some((key) => key.host === server.inner.host)).toBe(true);
    });

    it('passes through the same jump host twice when asked to', async () => {
      const again: SshHop = { ...edge, id: 'again', host: 'ssh', port: 22 };
      const config = await store.add(deep('postgres', 'postgres', [edge, again]), 'datanest', {
        edge: { password: server.password },
        again: { password: server.password },
        main: { passphrase: server.passphrase },
      });
      expect(await rows(manager, 'editor:a', config.id, 'SELECT 6')).toEqual([[6]]);
    });

    it('says which server could not reach the next one', async () => {
      const config = await store.add(
        {
          ...deep('postgres', 'postgres', [edge]),
          ssh: {
            id: 'main',
            host: 'no-such-ssh',
            user: server.user,
            auth: 'password',
            jumps: [edge],
          },
        },
        'datanest',
        { edge: { password: server.password } },
      );
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
        code: 'connection-failed',
        message: expect.stringContaining('cannot reach no-such-ssh:22') as unknown,
      });
    });

    it('reports a failed login on the inner server', async () => {
      const config = await store.add(deep('postgres', 'postgres', [edge]), 'datanest', {
        edge: { password: server.password },
        main: { passphrase: 'wrong' },
      });
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
        code: 'auth-failed',
        message: expect.stringContaining('Wrong passphrase') as unknown,
      });
    });
  });

  it('tests unsaved settings through a private tunnel', async () => {
    await manager.test(input('postgres', 'postgres'), 'datanest', {
      main: { password: server.password },
    });
    expect(pool.size).toBe(0);
  });
});

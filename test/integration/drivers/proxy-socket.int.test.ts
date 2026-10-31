// Proxies and Unix sockets against real databases (V10.2.5), through the connection
// manager as the extension uses it. The proxies are small ones of the tests
// (helpers/proxy-servers.ts) relaying to the compose servers; the sockets are local
// Unix sockets relaying to their TCP ports, so the drivers really speak over a socket.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { ssh } from '../../../src/services/ssh';
import { TunnelPool } from '../../../src/services/tunnels';
import type { ConnectionInput, ProxySettings } from '../../../src/shared/connection';
import { type CoreDatabaseId, testDatabase, testSshServer } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { startHttpProxy, startSocksProxy, type TestProxy } from '../../helpers/proxy-servers';

const DRIVERS: Readonly<Record<'mysql' | 'postgres', Driver>> = {
  mysql: mysqlDriver,
  postgres: postgresDriver,
};

const TARGETS: readonly { id: CoreDatabaseId; driver: 'mysql' | 'postgres' }[] = [
  { id: 'mysql', driver: 'mysql' },
  { id: 'mariadb', driver: 'mysql' },
  { id: 'postgres', driver: 'postgres' },
];

describe('proxies and Unix sockets to real databases', () => {
  const logger = new RecordingLogger();
  let store: ConnectionStore;
  let pool: TunnelPool;
  let manager: ConnectionManager;
  let socks: TestProxy;
  let socksLogin: TestProxy;
  let http: TestProxy;
  let dir: string;
  const relays: Server[] = [];

  beforeAll(async () => {
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
      checkHostKey: () => Promise.resolve(true),
    });
    socks = await startSocksProxy();
    socksLogin = await startSocksProxy({ user: 'proxy-user', password: 'proxy-pass' });
    http = await startHttpProxy({ user: 'proxy-user', password: 'proxy-pass' });
    dir = mkdtempSync(join(tmpdir(), 'datanest-sockets-'));
  });

  afterEach(async () => {
    for (const config of store.list()) {
      await manager.disconnect(config.id);
      await store.remove(config.id);
    }
  });

  afterAll(async () => {
    manager.dispose();
    pool.dispose();
    for (const proxy of [socks, socksLogin, http]) {
      await proxy.close();
    }
    for (const relay of relays) {
      await new Promise<void>((resolve) =>
        relay.close(() => {
          resolve();
        }),
      );
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function scalar(connectionId: string, sql: string): Promise<unknown> {
    const session = await manager.acquire('editor:proxy', { connectionId });
    try {
      for await (const event of session.execute(sql)) {
        if (event.kind === 'rows' && event.rows[0] !== undefined) {
          return event.rows[0][0];
        }
      }
      return undefined;
    } finally {
      await manager.release('editor:proxy');
    }
  }

  function direct(id: CoreDatabaseId, driver: 'mysql' | 'postgres'): ConnectionInput {
    const db = testDatabase(id);
    return {
      name: id,
      driver,
      host: db.host,
      port: db.port,
      user: db.user,
      database: db.database,
    };
  }

  /** A Unix socket at `path` that relays every connection to the server's TCP port. */
  async function socketTo(path: string, port: number): Promise<void> {
    const relay = createServer((local: Socket) => {
      const remote = connect({ host: '127.0.0.1', port });
      local.pipe(remote).pipe(local);
      remote.on('error', () => local.destroy());
      local.on('error', () => remote.destroy());
    });
    relays.push(relay);
    await new Promise<void>((resolve) => {
      relay.listen(path, resolve);
    });
  }

  it.each(TARGETS)('queries $id through a SOCKS5 proxy', async ({ id, driver }) => {
    const proxy: ProxySettings = { kind: 'socks5', host: '127.0.0.1', port: socks.port };
    const config = await store.add({ ...direct(id, driver), proxy }, testDatabase(id).password);
    expect(Number(await scalar(config.id, 'SELECT 41 + 1'))).toBe(42);
    expect(socks.requests.at(-1)).toBe(`${testDatabase(id).host}:${testDatabase(id).port}`);
  });

  it.each(TARGETS)(
    'queries $id through an HTTP proxy that wants a password',
    async ({ id, driver }) => {
      const proxy: ProxySettings = {
        kind: 'http',
        host: '127.0.0.1',
        port: http.port,
        user: 'proxy-user',
      };
      const config = await store.add(
        { ...direct(id, driver), proxy },
        testDatabase(id).password,
        {},
        {
          proxyPassword: 'proxy-pass',
        },
      );
      expect(Number(await scalar(config.id, 'SELECT 2 * 21'))).toBe(42);
    },
  );

  it('says when the proxy password is wrong', async () => {
    const proxy: ProxySettings = {
      kind: 'socks5',
      host: '127.0.0.1',
      port: socksLogin.port,
      user: 'proxy-user',
    };
    const config = await store.add(
      { ...direct('postgres', 'postgres'), proxy },
      'datanest',
      {},
      {
        proxyPassword: 'wrong',
      },
    );
    await expect(scalar(config.id, 'SELECT 1')).rejects.toMatchObject({
      message: expect.stringMatching(/proxy/iu) as unknown,
    });
  });

  it('tests a connection through a proxy before it is saved', async () => {
    const proxy: ProxySettings = {
      kind: 'socks5',
      host: '127.0.0.1',
      port: socksLogin.port,
      user: 'proxy-user',
    };
    await expect(
      manager.test(
        { ...direct('mysql', 'mysql'), proxy },
        testDatabase('mysql').password,
        {},
        undefined,
        'proxy-pass',
      ),
    ).resolves.toBeUndefined();
    await expect(
      manager.test(
        { ...direct('mysql', 'mysql'), proxy },
        testDatabase('mysql').password,
        {},
        undefined,
        'nope',
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/proxy/iu) as unknown });
  });

  it('reaches the first SSH server through the proxy', async () => {
    const server = testSshServer();
    const target = server.targets.postgres;
    const config = await store.add(
      {
        ...direct('postgres', 'postgres'),
        host: target.host,
        port: target.port,
        proxy: { kind: 'socks5', host: '127.0.0.1', port: socks.port },
        ssh: {
          id: 'main',
          host: server.host,
          port: server.port,
          user: server.user,
          auth: 'password',
        },
      },
      testDatabase('postgres').password,
      { main: { password: server.password } },
    );
    expect(Number(await scalar(config.id, 'SELECT 7 * 6'))).toBe(42);
    expect(socks.requests.at(-1)).toBe(`${server.host}:${server.port}`);
  });

  it.runIf(process.platform !== 'win32').each([
    { id: 'mysql' as const, driver: 'mysql' as const },
    { id: 'mariadb' as const, driver: 'mysql' as const },
  ])('queries $id through a Unix socket file', async ({ id, driver }) => {
    const path = join(dir, `${id}.sock`);
    await socketTo(path, testDatabase(id).port);
    const { host: _host, port: _port, ...rest } = direct(id, driver);
    const config = await store.add({ ...rest, socket: path }, testDatabase(id).password);
    expect(Number(await scalar(config.id, 'SELECT 40 + 2'))).toBe(42);
  });

  it.runIf(process.platform !== 'win32')(
    'queries PostgreSQL through a socket directory, and through the socket file',
    async () => {
      const db = testDatabase('postgres');
      await socketTo(join(dir, `.s.PGSQL.${db.port}`), db.port);
      const { host: _host, ...rest } = direct('postgres', 'postgres');
      const byDirectory = await store.add({ ...rest, name: 'dir', socket: dir }, db.password);
      expect(Number(await scalar(byDirectory.id, 'SELECT 42'))).toBe(42);
      const byFile = await store.add(
        { ...rest, name: 'file', port: undefined, socket: join(dir, `.s.PGSQL.${db.port}`) },
        db.password,
      );
      expect(Number(await scalar(byFile.id, 'SELECT 43'))).toBe(43);
    },
  );
});

// TLS against real servers: MySQL, MariaDB and PostgreSQL in docker/compose.yml run
// with the test CA from docker/tls. The server certificate covers localhost,
// 127.0.0.1, `mysql` and `postgres`, but not the `*-alias` network names.

import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { ssh } from '../../../src/services/ssh';
import { TunnelPool } from '../../../src/services/tunnels';
import type {
  ConnectionInput,
  ResolvedConnectionConfig,
  SslSettings,
} from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId, testSshServer } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { ROOT } from '../../helpers/repo';

const TLS = join(ROOT, 'docker', 'tls');
const CA = join(TLS, 'ca.crt');
const OTHER_CA = join(TLS, 'other-ca.crt');

interface Target {
  readonly id: TestDatabaseId;
  readonly driver: Driver;
  /** Whether this session is encrypted, as the server reports it. */
  readonly encryptedSql: string;
  /** The name the SSH server reaches it by, and one the certificate does not cover. */
  readonly inside: { readonly host: string; readonly alias: string; readonly port: number };
}

const TARGETS: readonly Target[] = [
  {
    id: 'mysql',
    driver: mysqlDriver,
    encryptedSql: "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
    inside: { host: 'mysql', alias: 'mysql-alias', port: 3306 },
  },
  {
    id: 'postgres',
    driver: postgresDriver,
    encryptedSql: 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
    inside: { host: 'postgres', alias: 'postgres-alias', port: 5432 },
  },
];

async function firstRow(session: Session, sql: string): Promise<unknown[]> {
  for await (const event of session.execute(sql)) {
    if (event.kind === 'rows' && event.rows[0] !== undefined) {
      return [...event.rows[0]];
    }
  }
  return [];
}

function direct(id: TestDatabaseId, ssl: SslSettings | undefined): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: 'tls',
    name: id,
    driver: id === 'postgres' ? 'postgres' : 'mysql',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ...(ssl === undefined ? {} : { ssl }),
  };
}

const sessions: Session[] = [];

async function open(target: Target, config: ResolvedConnectionConfig): Promise<Session> {
  const session = await target.driver.openSession(config);
  sessions.push(session);
  return session;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
});

/** True when the row says the session is encrypted, whatever the server's dialect. */
function encrypted(row: unknown[]): boolean {
  const value = row.at(-1);
  return value === true || (typeof value === 'string' && value !== '');
}

describe.each(TARGETS)('TLS to $id', (target) => {
  it('stays plain when TLS is not asked for', async () => {
    const session = await open(target, direct(target.id, undefined));
    expect(encrypted(await firstRow(session, target.encryptedSql))).toBe(false);
  });

  it('encrypts without checking the certificate in "require"', async () => {
    const session = await open(target, direct(target.id, { mode: 'require' }));
    expect(encrypted(await firstRow(session, target.encryptedSql))).toBe(true);
  });

  it('checks the issuer in "verify-ca"', async () => {
    const session = await open(target, direct(target.id, { mode: 'verify-ca', ca: CA }));
    expect(encrypted(await firstRow(session, target.encryptedSql))).toBe(true);
    await expect(
      open(target, direct(target.id, { mode: 'verify-ca', ca: OTHER_CA })),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('not trusted') as unknown,
    });
  });

  it('refuses an unknown issuer without a CA file (system CAs only)', async () => {
    await expect(open(target, direct(target.id, { mode: 'verify-ca' }))).rejects.toMatchObject({
      message: expect.stringContaining('not trusted') as unknown,
    });
  });

  it('checks the host name in "verify-full", also for an IP address', async () => {
    const byIp = await open(target, direct(target.id, { mode: 'verify-full', ca: CA }));
    expect(encrypted(await firstRow(byIp, target.encryptedSql))).toBe(true);
    const byName = await open(target, {
      ...direct(target.id, { mode: 'verify-full', ca: CA }),
      host: 'localhost',
    });
    expect(encrypted(await firstRow(byName, target.encryptedSql))).toBe(true);
  });

  it('reports a CA file that cannot be read', async () => {
    await expect(
      open(target, direct(target.id, { mode: 'verify-ca', ca: join(TLS, 'missing.crt') })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('logs in with a client certificate where the server requires one', async () => {
    const config: ResolvedConnectionConfig = {
      ...direct(target.id, {
        mode: 'verify-full',
        ca: CA,
        cert: join(TLS, 'client.crt'),
        key: join(TLS, 'client.key'),
      }),
      user: 'datanest_cert',
    };
    const session = await open(target, config);
    expect(encrypted(await firstRow(session, target.encryptedSql))).toBe(true);
    await expect(
      open(target, { ...config, ssl: { mode: 'verify-full', ca: CA } }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/auth-failed|permission-denied/) as unknown,
    });
  });
});

describe('TLS to PostgreSQL while cancelling', () => {
  it('opens the cancel connection with the same TLS settings', async () => {
    const target = TARGETS.find((each) => each.id === 'postgres');
    if (target === undefined) {
      throw new Error('expected the PostgreSQL target');
    }
    const session = await open(target, direct('postgres', { mode: 'verify-full', ca: CA }));
    const run = (async () => {
      for await (const _event of session.execute('SELECT pg_sleep(30)')) {
        // Waiting for the cancel.
      }
    })();
    const cancelled = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel();
    await cancelled;
  });
});

describe.each(TARGETS)('TLS to $id through an SSH tunnel', (target) => {
  const server = testSshServer();
  const logger = new RecordingLogger();
  let store: ConnectionStore;
  let pool: TunnelPool;
  let manager: ConnectionManager;

  function viaSsh(host: string, ssl: SslSettings): ConnectionInput {
    const db = testDatabase(target.id);
    return {
      name: `${target.id} tls`,
      driver: target.id === 'postgres' ? 'postgres' : 'mysql',
      host,
      port: target.inside.port,
      user: db.user,
      database: db.database,
      ssl,
      ssh: {
        id: 'main',
        host: server.host,
        port: server.port,
        user: server.user,
        auth: 'password',
      },
    };
  }

  async function query(input: ConnectionInput): Promise<unknown[]> {
    const config = await store.add(input, 'datanest', { main: { password: server.password } });
    const session = await manager.acquire(`editor:${config.id}`, { connectionId: config.id });
    return await firstRow(session, target.encryptedSql);
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
      drivers: { get: () => Promise.resolve(target.driver) },
      logger,
      tunnels: pool,
      checkHostKey: () => Promise.resolve(true),
    });
  });

  afterAll(() => {
    manager.dispose();
    pool.dispose();
  });

  it('checks the certificate against the real server name, not the tunnel port', async () => {
    expect(
      encrypted(await query(viaSsh(target.inside.host, { mode: 'verify-full', ca: CA }))),
    ).toBe(true);
  });

  it('refuses a name the certificate does not cover, unless only the issuer is checked', async () => {
    await expect(
      query(viaSsh(target.inside.alias, { mode: 'verify-full', ca: CA })),
    ).rejects.toMatchObject({
      message: expect.stringContaining(`not issued for "${target.inside.alias}"`) as unknown,
    });
    expect(encrypted(await query(viaSsh(target.inside.alias, { mode: 'verify-ca', ca: CA })))).toBe(
      true,
    );
  });
});

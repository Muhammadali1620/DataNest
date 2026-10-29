import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { GROUPS_ENV } from '../../helpers/integration-groups';
import { setup } from '../../helpers/integration-setup';

// Ports for these tests also stay in 7000-7999 (D17); pick free ones near the top.
async function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  for (let port = 7999; port >= 7900; port--) {
    const server = createServer((socket) => socket.destroy());
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => {
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => {
        resolve(true);
      });
    });
    if (ok) {
      return { server, port };
    }
  }
  throw new Error('No free port in 7900-7999');
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe('integration global setup', () => {
  let open: { server: Server; port: number };
  let closedPort: number;

  beforeEach(async () => {
    open = await listenOnFreePort();
    const probe = await listenOnFreePort();
    closedPort = probe.port;
    await close(probe.server);
    vi.stubEnv(GROUPS_ENV, '');
  });

  afterEach(async () => {
    await close(open.server);
  });

  it('passes when every database port accepts connections', async () => {
    vi.stubEnv('DATANEST_MYSQL_PORT', String(open.port));
    vi.stubEnv('DATANEST_MARIADB_PORT', String(open.port));
    vi.stubEnv('DATANEST_POSTGRES_PORT', String(open.port));
    vi.stubEnv('DATANEST_SSH_PORT', String(open.port));
    await expect(setup()).resolves.toBeUndefined();
  });

  it('checks the groups the config chose', async () => {
    vi.stubEnv(GROUPS_ENV, 'core');
    vi.stubEnv('DATANEST_MYSQL_PORT', String(open.port));
    vi.stubEnv('DATANEST_MARIADB_PORT', String(open.port));
    vi.stubEnv('DATANEST_POSTGRES_PORT', String(closedPort));
    vi.stubEnv('DATANEST_SSH_PORT', String(open.port));
    await expect(setup()).rejects.toThrow(`postgres (127.0.0.1:${closedPort})`);
  });

  it('also needs the SSH server the tunnel tests go through', async () => {
    vi.stubEnv('DATANEST_MYSQL_PORT', String(open.port));
    vi.stubEnv('DATANEST_MARIADB_PORT', String(open.port));
    vi.stubEnv('DATANEST_POSTGRES_PORT', String(open.port));
    vi.stubEnv('DATANEST_SSH_PORT', String(closedPort));
    await expect(setup()).rejects.toThrow(`ssh (127.0.0.1:${closedPort})`);
  });

  it('names every unreachable database and tells how to start them', async () => {
    vi.stubEnv('DATANEST_MYSQL_PORT', String(open.port));
    vi.stubEnv('DATANEST_MARIADB_PORT', String(closedPort));
    vi.stubEnv('DATANEST_POSTGRES_PORT', String(closedPort));
    vi.stubEnv('DATANEST_SSH_PORT', String(open.port));
    await expect(setup()).rejects.toThrow(
      `Test databases are not reachable: mariadb (127.0.0.1:${closedPort}), ` +
        `postgres (127.0.0.1:${closedPort}). Run "npm run db:up".`,
    );
  });

  it('names the group to start when it is not core', async () => {
    vi.stubEnv(GROUPS_ENV, 'mssql');
    vi.stubEnv('DATANEST_MSSQL_PORT', String(closedPort));
    await expect(setup()).rejects.toThrow(
      `Test databases are not reachable: mssql (127.0.0.1:${closedPort}). ` +
        'Run "npm run db:up -- mssql".',
    );
  });

  it('checks only the named groups', async () => {
    vi.stubEnv(GROUPS_ENV, 'mssql');
    vi.stubEnv('DATANEST_MSSQL_PORT', String(open.port));
    vi.stubEnv('DATANEST_MYSQL_PORT', String(closedPort));
    await expect(setup()).resolves.toBeUndefined();
  });

  it('refuses an unknown group before connecting anywhere', async () => {
    vi.stubEnv(GROUPS_ENV, 'db2');
    await expect(setup()).rejects.toThrow(/unknown groups: db2/u);
  });

  it('throws an error without stack frames, so Vitest can print it', async () => {
    vi.stubEnv('DATANEST_MYSQL_PORT', String(closedPort));
    vi.stubEnv('DATANEST_MARIADB_PORT', String(open.port));
    vi.stubEnv('DATANEST_POSTGRES_PORT', String(open.port));
    const error = await setup().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).stack).toBe(`Error: ${(error as Error).message}`);
  });

  it('rejects ports outside 7000-7999 before connecting anywhere', async () => {
    vi.stubEnv('DATANEST_MYSQL_PORT', '3306');
    await expect(setup()).rejects.toThrow('DATANEST_MYSQL_PORT must be within 7000-7999');
  });
});

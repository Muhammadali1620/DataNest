import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
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
  });

  afterEach(async () => {
    await close(open.server);
  });

  it('passes when every database port accepts connections', async () => {
    vi.stubEnv('DATANEST_MYSQL_PORT', String(open.port));
    vi.stubEnv('DATANEST_MARIADB_PORT', String(open.port));
    vi.stubEnv('DATANEST_POSTGRES_PORT', String(open.port));
    await expect(setup()).resolves.toBeUndefined();
  });

  it('names every unreachable database and tells how to start them', async () => {
    vi.stubEnv('DATANEST_MYSQL_PORT', String(open.port));
    vi.stubEnv('DATANEST_MARIADB_PORT', String(closedPort));
    vi.stubEnv('DATANEST_POSTGRES_PORT', String(closedPort));
    await expect(setup()).rejects.toThrow(
      `Test databases are not reachable: mariadb (127.0.0.1:${closedPort}), ` +
        `postgres (127.0.0.1:${closedPort}). Run "npm run db:up".`,
    );
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

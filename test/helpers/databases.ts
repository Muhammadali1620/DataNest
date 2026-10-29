// Connection settings for the databases from docker/compose.yml.
// Ports can be overridden with env vars, but must stay in 7000-7999 (ARCHITECTURE.md D17).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TestDatabaseId = 'mysql' | 'mariadb' | 'postgres' | 'mssql';

/** The databases of the `core` group, which the SSH server can reach. */
export type CoreDatabaseId = 'mysql' | 'mariadb' | 'postgres';

export interface TestDatabase {
  readonly id: TestDatabaseId;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** A second database without tables. */
  readonly emptyDatabase: string;
}

export const PORT_RANGE = { min: 7000, max: 7999 } as const;

export const DEFAULT_PORTS: Readonly<Record<TestDatabaseId, number>> = {
  mysql: 7306,
  mariadb: 7307,
  postgres: 7432,
  mssql: 7143,
};

export const PORT_ENV: Readonly<Record<TestDatabaseId, string>> = {
  mysql: 'DATANEST_MYSQL_PORT',
  mariadb: 'DATANEST_MARIADB_PORT',
  postgres: 'DATANEST_POSTGRES_PORT',
  mssql: 'DATANEST_MSSQL_PORT',
};

/** Reads a port from `env`, falling back to the default; rejects ports outside 7000-7999. */
export function resolvePort(
  id: TestDatabaseId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const name = PORT_ENV[id];
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_PORTS[id];
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  const port = Number(raw);
  if (port < PORT_RANGE.min || port > PORT_RANGE.max) {
    throw new Error(`${name} must be within ${PORT_RANGE.min}-${PORT_RANGE.max}, got ${port}`);
  }
  return port;
}

export function testDatabase(
  id: TestDatabaseId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TestDatabase {
  return {
    id,
    host: '127.0.0.1',
    port: resolvePort(id, env),
    user: 'datanest',
    password: 'datanest',
    database: 'datanest_test',
    emptyDatabase: 'datanest_empty',
  };
}

/** The SSH server from docker/compose.yml; the databases sit behind it (V4). */
export interface TestSshServer {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** Private key the server accepts, encrypted with `passphrase`. */
  readonly keyFile: string;
  readonly passphrase: string;
  /** How the databases are named inside the compose network, as the server sees them. */
  readonly targets: Readonly<Record<CoreDatabaseId, { host: string; port: number }>>;
  /** A second server with the same users, reachable only through this one. */
  readonly inner: { readonly host: string; readonly port: number };
}

export const SSH_PORT_ENV = 'DATANEST_SSH_PORT';
export const DEFAULT_SSH_PORT = 7022;

export function testSshServer(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TestSshServer {
  const raw = env[SSH_PORT_ENV]?.trim();
  const port = raw === undefined || raw === '' ? DEFAULT_SSH_PORT : Number(raw);
  if (!Number.isInteger(port) || port < PORT_RANGE.min || port > PORT_RANGE.max) {
    throw new Error(`${SSH_PORT_ENV} must be within ${PORT_RANGE.min}-${PORT_RANGE.max}`);
  }
  return {
    host: '127.0.0.1',
    port,
    user: 'datanest',
    password: 'datanest',
    keyFile: join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ssh', 'id_ed25519'),
    passphrase: 'datanest-key',
    targets: {
      mysql: { host: 'mysql', port: 3306 },
      mariadb: { host: 'mariadb', port: 3306 },
      postgres: { host: 'postgres', port: 5432 },
    },
    inner: { host: 'ssh-inner', port: 22 },
  };
}

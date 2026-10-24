// Connection settings for the databases from docker/compose.yml.
// Ports can be overridden with env vars, but must stay in 7000-7999 (ARCHITECTURE.md D17).

export type TestDatabaseId = 'mysql' | 'mariadb' | 'postgres';

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
};

export const PORT_ENV: Readonly<Record<TestDatabaseId, string>> = {
  mysql: 'DATANEST_MYSQL_PORT',
  mariadb: 'DATANEST_MARIADB_PORT',
  postgres: 'DATANEST_POSTGRES_PORT',
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

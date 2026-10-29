// Which databases and schemas belong to the server rather than to the user.
// The tree hides them unless `datanest.showSystemObjects` is on.

import type { DriverId } from '../../shared/connection';

/**
 * Databases the server keeps for itself. `postgres` is left out on purpose: it is
 * a normal database that people do use, even though the server creates it.
 */
const SYSTEM_DATABASES: Readonly<Record<DriverId, readonly string[]>> = {
  mysql: ['information_schema', 'performance_schema', 'mysql', 'sys'],
  postgres: ['template0', 'template1'],
  sqlite: [],
  // The server's own tools keep these four apart as "system databases" too.
  mssql: ['master', 'model', 'msdb', 'tempdb'],
  clickhouse: ['system', 'INFORMATION_SCHEMA', 'information_schema'],
  // The database is the service the connection opens; it has no siblings to hide.
  oracle: [],
};

/** Schemas the server keeps for itself. */
const SYSTEM_SCHEMAS: Readonly<Record<DriverId, readonly string[]>> = {
  mysql: [],
  postgres: ['pg_catalog', 'information_schema'],
  sqlite: [],
  mssql: ['sys', 'INFORMATION_SCHEMA', 'guest'],
  clickhouse: [],
  // The reader lists only schemas Oracle does not maintain itself; these two are for sure.
  oracle: ['SYS', 'SYSTEM', 'PDBADMIN'],
};

/** Prefixes of generated schemas: PostgreSQL numbers them per session. */
const SYSTEM_SCHEMA_PREFIXES: Readonly<Record<DriverId, readonly string[]>> = {
  mysql: [],
  postgres: ['pg_toast', 'pg_temp_', 'pg_toast_temp_'],
  sqlite: [],
  mssql: [],
  clickhouse: [],
  oracle: [],
};

function equalsAny(name: string, names: readonly string[]): boolean {
  // Server object names are case-insensitive in practice for these built-ins.
  const lower = name.toLowerCase();
  return names.some((candidate) => candidate.toLowerCase() === lower);
}

export function isSystemDatabase(driver: DriverId, name: string): boolean {
  return equalsAny(name, SYSTEM_DATABASES[driver]);
}

export function isSystemSchema(driver: DriverId, name: string): boolean {
  if (equalsAny(name, SYSTEM_SCHEMAS[driver])) {
    return true;
  }
  const lower = name.toLowerCase();
  return SYSTEM_SCHEMA_PREFIXES[driver].some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/** Keeps the order the server returned, dropping the server's own databases. */
export function withoutSystemDatabases(driver: DriverId, names: readonly string[]): string[] {
  return names.filter((name) => !isSystemDatabase(driver, name));
}

export function withoutSystemSchemas(driver: DriverId, names: readonly string[]): string[] {
  return names.filter((name) => !isSystemSchema(driver, name));
}

// The small facts the tree writes after a name: the version of a server after the
// connection (`gamezone.dev 15.19`) and the size of a schema or database (`public 2.4M`).
// Read lazily, kept until the tree refreshes, and never allowed to fail the tree: a server
// that does not say simply leaves the name alone (V11.14).

import { type DriverId, type SqlDriverId, isSqlDriver } from '../shared/connection';
import { browseSession } from './browse-session';
import { ConnectionManager } from './connection-manager';
import { namedRows, numberOf, textOf } from './monitor/rows';
import { readServerInfo } from './redis/server-info';

type Reader = Pick<
  ConnectionManager,
  'acquire' | 'driverOf' | 'acquireRedis' | 'acquireMongo' | 'acquireElastic'
>;

/** `15.19 (Debian 15.19-1.pgdg120+1)` → `15.19`; `10.11.6-MariaDB-1:…` → `10.11.6`. */
export function shortVersion(text: string): string | undefined {
  return /\d+(?:\.\d+){0,3}/.exec(text)?.[0];
}

/** `2.4M`, `812K`, `1.2G`: the short form of a size in bytes. */
export function shortSize(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text =
    unit === 0 || value >= 100
      ? Math.round(value).toString()
      : value.toFixed(1).replace(/\.0$/, '');
  return `${text}${units[unit] ?? 'B'}`;
}

const VERSION_SQL: Readonly<Record<SqlDriverId, string>> = {
  mysql: 'SELECT VERSION() AS version',
  postgres: "SELECT current_setting('server_version') AS version",
  sqlite: 'SELECT sqlite_version() AS version',
  mssql: "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version",
  clickhouse: 'SELECT version() AS version',
  oracle: 'SELECT version AS version FROM product_component_version WHERE ROWNUM = 1',
};

/** The version of the server behind a connection; undefined where it does not say. */
export async function readServerVersion(
  manager: Reader,
  connectionId: string,
  driver: DriverId,
): Promise<string | undefined> {
  const owner = ConnectionManager.treeOwner(connectionId);
  if (driver === 'redis') {
    const session = await manager.acquireRedis(owner, { connectionId });
    const [node] = await readServerInfo(session, () => '');
    return node?.summary.version === undefined ? undefined : shortVersion(node.summary.version);
  }
  if (driver === 'mongodb') {
    return shortVersion((await manager.acquireMongo(owner, { connectionId })).server.version);
  }
  if (driver === 'elasticsearch') {
    return shortVersion((await manager.acquireElastic(owner, { connectionId })).server.version);
  }
  const session = await browseSession(manager, connectionId);
  const [row] = await namedRows(session, VERSION_SQL[driver]);
  const text = row === undefined ? undefined : textOf(row, 'version');
  return text === undefined ? undefined : shortVersion(text);
}

/** Where a size is asked for: a whole database, or one schema of it. */
export interface SizeTarget {
  readonly database?: string | undefined;
  readonly schema?: string | undefined;
}

/**
 * The statement that sums the size of a database or schema, undefined where there is no
 * cheap way (SQLite files, Oracle). `literal` and `quote` come from the dialect.
 */
export function sizeSql(
  driver: DriverId,
  target: SizeTarget,
  dialect: { literal(value: string): string; quote(name: string): string },
): string | undefined {
  const { database, schema } = target;
  switch (driver) {
    case 'postgres':
      return schema === undefined
        ? 'SELECT pg_database_size(current_database()) AS size'
        : `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${dialect.literal(schema)} AND c.relkind IN ('r', 'm', 'p')`;
    case 'mysql': {
      const name = schema ?? database;
      return name === undefined
        ? undefined
        : `SELECT COALESCE(SUM(data_length + index_length), 0) AS size
FROM information_schema.tables WHERE table_schema = ${dialect.literal(name)}`;
    }
    case 'mssql': {
      const prefix = database === undefined ? '' : `${dialect.quote(database)}.`;
      const owner =
        schema === undefined
          ? ''
          : ` JOIN ${prefix}sys.objects o ON o.object_id = ps.object_id
JOIN ${prefix}sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = ${dialect.literal(schema)}`;
      return `SELECT COALESCE(SUM(CAST(ps.used_page_count AS bigint)), 0) * 8192 AS size
FROM ${prefix}sys.dm_db_partition_stats ps${owner}`;
    }
    case 'clickhouse':
      return database === undefined
        ? undefined
        : `SELECT COALESCE(SUM(bytes_on_disk), 0) AS size FROM system.parts
WHERE active AND database = ${dialect.literal(database)}`;
    case 'sqlite':
    case 'oracle':
    case 'redis':
    case 'mongodb':
    case 'elasticsearch':
      return undefined;
  }
}

/** The size in bytes of a database or schema; undefined where it cannot be told. */
export async function readSizeBytes(
  manager: Reader,
  connectionId: string,
  driver: DriverId,
  target: SizeTarget,
): Promise<number | undefined> {
  if (!isSqlDriver(driver)) {
    return undefined;
  }
  const { dialect } = await manager.driverOf(connectionId);
  const sql = sizeSql(driver, target, {
    literal: (value) => dialect.literal(value),
    quote: (name) => dialect.quoteIdentifier(name),
  });
  if (sql === undefined) {
    return undefined;
  }
  const session = await browseSession(manager, connectionId, target.database);
  const [row] = await namedRows(session, sql);
  return row === undefined ? undefined : numberOf(row, 'size');
}

/**
 * What the tree has learned so far, by key. `ask` starts one read per key and calls
 * `changed` when the answer lands, so the tree redraws just that item; a failed read is
 * passed to `failed` and remembered as "nothing to show" until the cache is cleared (every
 * refresh and every connection state change clears it, so the next one asks again).
 */
export class LabelCache<T> {
  private readonly values = new Map<string, T | null>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly changed: (key: string) => void,
    private readonly failed?: (key: string, error: unknown) => void,
  ) {}

  /** The answer, undefined while unknown or when the server had none. */
  peek(key: string): T | undefined {
    return this.values.get(key) ?? undefined;
  }

  /** Starts the read once; the answer is picked up with `peek` after `changed`. */
  ask(key: string, read: () => Promise<T | undefined>): void {
    if (this.values.has(key) || this.pending.has(key)) {
      return;
    }
    this.pending.add(key);
    void read()
      .then(
        (value) => this.values.set(key, value ?? null),
        (error: unknown) => {
          this.failed?.(key, error);
          this.values.set(key, null);
        },
      )
      .finally(() => {
        this.pending.delete(key);
        this.changed(key);
      });
  }

  /** Forgets the answers whose key starts with `prefix` (all of them without one). */
  clear(prefix = ''): void {
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) {
        this.values.delete(key);
      }
    }
  }
}

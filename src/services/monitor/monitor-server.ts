// Which server a monitor (V8.5) talks to, and what it can show and do there. Servers
// of one driver differ here as much as in EXPLAIN: MariaDB and TiDB list processes
// like MySQL but report themselves differently, CockroachDB has no pg_stat_activity.

import type { Session } from '../../drivers/driver';
import type { SqlDriverId } from '../../shared/connection';
import { planServerOf } from '../explain/explain';

export type MonitorServer =
  | 'postgres'
  | 'cockroach'
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'sqlite'
  | 'mssql'
  | 'clickhouse'
  | 'oracle';

/** Where a setting applies: this session, or the whole server (cluster, instance). */
export type SettingScope = 'session' | 'server';

/** How the server names its side of the settings, for the page's scope switch. */
export type ServerScopeName = 'global' | 'cluster' | 'server' | 'system';

export interface MonitorFeatures {
  /** The server has sessions of other clients to list (a SQLite file has none). */
  readonly processes: boolean;
  /** A running statement of another session can be stopped, the session kept. */
  readonly cancel: boolean;
  /** Another session can be closed. */
  readonly terminate: boolean;
  /** The scopes of settings the server shows, the first one opened first. */
  readonly scopes: readonly SettingScope[];
  readonly serverScope: ServerScopeName;
}

const FEATURES: Readonly<Record<MonitorServer, MonitorFeatures>> = {
  postgres: {
    processes: true,
    cancel: true,
    terminate: true,
    scopes: ['session'],
    serverScope: 'server',
  },
  cockroach: {
    processes: true,
    cancel: true,
    terminate: true,
    scopes: ['session', 'server'],
    serverScope: 'cluster',
  },
  mysql: {
    processes: true,
    cancel: true,
    terminate: true,
    scopes: ['session', 'server'],
    serverScope: 'global',
  },
  mariadb: {
    processes: true,
    cancel: true,
    terminate: true,
    scopes: ['session', 'server'],
    serverScope: 'global',
  },
  tidb: {
    processes: true,
    cancel: true,
    terminate: true,
    scopes: ['session', 'server'],
    serverScope: 'global',
  },
  sqlite: {
    processes: false,
    cancel: false,
    terminate: false,
    scopes: ['session'],
    serverScope: 'server',
  },
  // KILL ends the whole session: SQL Server cannot stop only another session's batch.
  mssql: {
    processes: true,
    cancel: false,
    terminate: true,
    scopes: ['session', 'server'],
    serverScope: 'server',
  },
  // ClickHouse lists running queries, not sessions, so there is nothing to close.
  clickhouse: {
    processes: true,
    cancel: true,
    terminate: false,
    scopes: ['session', 'server'],
    serverScope: 'server',
  },
  oracle: {
    processes: true,
    cancel: true,
    terminate: true,
    scopes: ['session', 'server'],
    serverScope: 'system',
  },
};

export function monitorFeatures(server: MonitorServer): MonitorFeatures {
  return FEATURES[server];
}

/** The product name the page shows next to the connection. */
export const SERVER_NAMES: Readonly<Record<MonitorServer, string>> = {
  postgres: 'PostgreSQL',
  cockroach: 'CockroachDB',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  tidb: 'TiDB',
  sqlite: 'SQLite',
  mssql: 'SQL Server',
  clickhouse: 'ClickHouse',
  oracle: 'Oracle',
};

/** Asks the server who it is, where the driver alone does not tell. */
export async function monitorServerOf(
  session: Session,
  driver: SqlDriverId,
): Promise<MonitorServer> {
  const server = await planServerOf(session, driver);
  // Old MySQL explains differently but lists processes the same way.
  return server === 'mysql-old' ? 'mysql' : server;
}

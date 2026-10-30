// Server status (V8.5): the counters a server keeps about itself, and the few numbers
// worth a glance — version, uptime, connections and a rate of queries or transactions.

import type { Session } from '../../drivers/driver';
import type { MonitorServer } from './monitor-server';
import { namedRows, numberOf, textOf, toNumber } from './rows';

export interface StatusValue {
  readonly name: string;
  readonly value: string;
  /** Where the value comes from, where a server keeps several lists (ClickHouse). */
  readonly group?: string;
}

export interface ServerSummary {
  readonly version?: string;
  readonly uptimeSeconds?: number;
  readonly connections?: number;
  readonly maxConnections?: number;
  /** The size of the database file or the current database. */
  readonly sizeBytes?: number;
  /** A counter that only grows; its change between readings is the rate shown. */
  readonly rate?: { readonly kind: 'queries' | 'transactions'; readonly total: number };
}

export interface ServerStatus {
  readonly values: readonly StatusValue[];
  readonly summary: ServerSummary;
}

const POSTGRES_DATABASE_COUNTERS = [
  'numbackends',
  'xact_commit',
  'xact_rollback',
  'blks_read',
  'blks_hit',
  'tup_returned',
  'tup_fetched',
  'tup_inserted',
  'tup_updated',
  'tup_deleted',
  'conflicts',
  'temp_files',
  'temp_bytes',
  'deadlocks',
  'blk_read_time',
  'blk_write_time',
];

const POSTGRES_SUMMARY = `SELECT current_setting('server_version') AS version,
  EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time())) AS uptime,
  (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections,
  current_setting('max_connections') AS max_connections,
  pg_database_size(current_database()) AS size`;

const MSSQL_SUMMARY = `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) + ' ' +
    CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS version,
  (SELECT DATEDIFF(SECOND, sqlserver_start_time, SYSDATETIME()) FROM sys.dm_os_sys_info) AS uptime,
  (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS connections,
  @@MAX_CONNECTIONS AS max_connections`;

// Counters of the whole instance only: per-database and per-object ones run to thousands.
const MSSQL_COUNTERS = `SELECT RTRIM(object_name) AS object_name, RTRIM(counter_name) AS counter_name,
  cntr_value
FROM sys.dm_os_performance_counters
WHERE instance_name IN ('', '_Total')`;

const CLICKHOUSE_VALUES = `SELECT 'metrics' AS grp, metric AS name, toString(value) AS value
  FROM system.metrics
UNION ALL SELECT 'events', event, toString(value) FROM system.events
UNION ALL SELECT 'asynchronous_metrics', metric, toString(value) FROM system.asynchronous_metrics`;

/** ClickHouse's connections by protocol, which together are the clients. */
const CLICKHOUSE_CONNECTIONS = [
  'TCPConnection',
  'HTTPConnection',
  'MySQLConnection',
  'PostgreSQLConnection',
];

const ORACLE_SUMMARY = `SELECT i.version_full AS version,
  ROUND((SYSDATE - i.startup_time) * 86400) AS uptime,
  (SELECT COUNT(*) FROM v$session WHERE type = 'USER') AS connections,
  (SELECT value FROM v$parameter WHERE name = 'sessions') AS max_connections
FROM v$instance i`;

export async function readStatus(session: Session, server: MonitorServer): Promise<ServerStatus> {
  switch (server) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
      return await mysqlStatus(session);
    case 'postgres':
      return await postgresStatus(session);
    case 'cockroach':
      return await cockroachStatus(session);
    case 'mssql':
      return await mssqlStatus(session);
    case 'clickhouse':
      return await clickhouseStatus(session);
    case 'oracle':
      return await oracleStatus(session);
    case 'sqlite':
      return await sqliteStatus(session);
  }
}

async function mysqlStatus(session: Session): Promise<ServerStatus> {
  const values = (await namedRows(session, 'SHOW GLOBAL STATUS')).map((row) =>
    value(textOf(row, 'variable_name'), textOf(row, 'value')),
  );
  const [info] = await namedRows(
    session,
    'SELECT VERSION() AS version, @@max_connections AS max_connections',
  );
  const find = finder(values);
  return {
    values,
    summary: summary({
      version: info === undefined ? undefined : textOf(info, 'version'),
      uptimeSeconds: find('Uptime'),
      connections: find('Threads_connected'),
      maxConnections: info === undefined ? undefined : numberOf(info, 'max_connections'),
      rate: rate('queries', find('Questions')),
    }),
  };
}

async function postgresStatus(session: Session): Promise<ServerStatus> {
  const [totals] = await namedRows(
    session,
    `SELECT ${POSTGRES_DATABASE_COUNTERS.map((name) => `sum(${name}) AS ${name}`).join(', ')}
     FROM pg_stat_database`,
  );
  const values: StatusValue[] = POSTGRES_DATABASE_COUNTERS.map((name) =>
    value(name, totals === undefined ? undefined : textOf(totals, name), 'pg_stat_database'),
  );
  const [writer] = await namedRows(session, 'SELECT * FROM pg_stat_bgwriter');
  if (writer !== undefined) {
    for (const name of writer.keys()) {
      values.push(value(name, textOf(writer, name), 'pg_stat_bgwriter'));
    }
  }
  const [info] = await namedRows(session, POSTGRES_SUMMARY);
  const find = finder(values);
  const commits = find('xact_commit');
  const rollbacks = find('xact_rollback');
  return {
    values,
    summary: summary({
      version: info === undefined ? undefined : textOf(info, 'version'),
      uptimeSeconds: info === undefined ? undefined : numberOf(info, 'uptime'),
      connections: info === undefined ? undefined : numberOf(info, 'connections'),
      maxConnections: info === undefined ? undefined : numberOf(info, 'max_connections'),
      sizeBytes: info === undefined ? undefined : numberOf(info, 'size'),
      rate: rate(
        'transactions',
        commits === undefined || rollbacks === undefined ? undefined : commits + rollbacks,
      ),
    }),
  };
}

async function cockroachStatus(session: Session): Promise<ServerStatus> {
  const values = (
    await namedRows(session, 'SELECT name, value FROM crdb_internal.node_metrics')
  ).map((row) => value(textOf(row, 'name'), textOf(row, 'value')));
  const [info] = await namedRows(session, 'SELECT version() AS version');
  const find = finder(values);
  return {
    values,
    summary: summary({
      version: info === undefined ? undefined : versionWord(textOf(info, 'version')),
      uptimeSeconds: find('sys.uptime'),
      connections: find('sql.conns'),
      rate: rate('queries', find('sql.query.count')),
    }),
  };
}

async function mssqlStatus(session: Session): Promise<ServerStatus> {
  const values = (await namedRows(session, MSSQL_COUNTERS)).map((row) => {
    // `SQLServer:General Statistics`, or `MSSQL$NAME:…` on a named instance.
    const object = (textOf(row, 'object_name') ?? '').replace(/^[^:]*:/u, '');
    return value(textOf(row, 'counter_name'), textOf(row, 'cntr_value'), object);
  });
  const [info] = await namedRows(session, MSSQL_SUMMARY);
  // Batch Requests/sec is kept as a running total; the rate is its change.
  const batches = values.find(
    (one) => one.group === 'SQL Statistics' && one.name === 'Batch Requests/sec',
  );
  return {
    values,
    summary: summary({
      version: info === undefined ? undefined : textOf(info, 'version'),
      uptimeSeconds: info === undefined ? undefined : numberOf(info, 'uptime'),
      connections: info === undefined ? undefined : numberOf(info, 'connections'),
      maxConnections: info === undefined ? undefined : numberOf(info, 'max_connections'),
      rate: rate('queries', toNumber(batches?.value)),
    }),
  };
}

async function clickhouseStatus(session: Session): Promise<ServerStatus> {
  const values = (await namedRows(session, CLICKHOUSE_VALUES)).map((row) =>
    value(textOf(row, 'name'), textOf(row, 'value'), textOf(row, 'grp')),
  );
  const [info] = await namedRows(session, 'SELECT version() AS version, uptime() AS uptime');
  const metric = (name: string): number | undefined =>
    toNumber(values.find((one) => one.group === 'metrics' && one.name === name)?.value);
  const connections = CLICKHOUSE_CONNECTIONS.map(metric).filter(
    (count): count is number => count !== undefined,
  );
  const queries = values.find((one) => one.group === 'events' && one.name === 'Query');
  return {
    values,
    summary: summary({
      version: info === undefined ? undefined : textOf(info, 'version'),
      uptimeSeconds: info === undefined ? undefined : numberOf(info, 'uptime'),
      connections:
        connections.length === 0 ? undefined : connections.reduce((sum, one) => sum + one, 0),
      // Before its first query a server has no `Query` event at all.
      rate: rate('queries', toNumber(queries?.value) ?? 0),
    }),
  };
}

async function oracleStatus(session: Session): Promise<ServerStatus> {
  const values = (await namedRows(session, 'SELECT name, value FROM v$sysstat')).map((row) =>
    value(textOf(row, 'name'), textOf(row, 'value')),
  );
  const [info] = await namedRows(session, ORACLE_SUMMARY);
  const find = finder(values);
  return {
    values,
    summary: summary({
      version: info === undefined ? undefined : textOf(info, 'version'),
      uptimeSeconds: info === undefined ? undefined : numberOf(info, 'uptime'),
      connections: info === undefined ? undefined : numberOf(info, 'connections'),
      maxConnections: info === undefined ? undefined : numberOf(info, 'max_connections'),
      rate: rate('queries', find('execute count')),
    }),
  };
}

async function sqliteStatus(session: Session): Promise<ServerStatus> {
  const [info] = await namedRows(
    session,
    `SELECT sqlite_version() AS version,
       (SELECT page_count FROM pragma_page_count()) AS page_count,
       (SELECT page_size FROM pragma_page_size()) AS page_size,
       (SELECT freelist_count FROM pragma_freelist_count()) AS freelist_count`,
  );
  const values = ['page_count', 'page_size', 'freelist_count'].map((name) =>
    value(name, info === undefined ? undefined : textOf(info, name)),
  );
  const find = finder(values);
  const pages = find('page_count');
  const pageSize = find('page_size');
  return {
    values,
    summary: summary({
      version: info === undefined ? undefined : textOf(info, 'version'),
      sizeBytes: pages === undefined || pageSize === undefined ? undefined : pages * pageSize,
    }),
  };
}

function value(name: string | undefined, text: string | undefined, group?: string): StatusValue {
  return {
    name: name ?? '',
    value: text ?? '',
    ...(group === undefined || group === '' ? {} : { group }),
  };
}

function finder(values: readonly StatusValue[]): (name: string) => number | undefined {
  const byName = new Map(values.map((one) => [one.name.toLowerCase(), one.value]));
  return (name) => toNumber(byName.get(name.toLowerCase()));
}

function rate(
  kind: 'queries' | 'transactions',
  total: number | undefined,
): ServerSummary['rate'] | undefined {
  return total === undefined ? undefined : { kind, total };
}

/** `CockroachDB CCL v24.3.6 (x86_64-pc-linux-gnu, …)` → `v24.3.6`. */
function versionWord(text: string | undefined): string | undefined {
  return text === undefined ? undefined : (/\bv\d[\w.-]*/u.exec(text)?.[0] ?? text);
}

type SummaryParts = { readonly [K in keyof ServerSummary]?: ServerSummary[K] | undefined };

function summary(parts: SummaryParts): ServerSummary {
  return {
    ...(parts.version === undefined ? {} : { version: parts.version }),
    ...(parts.uptimeSeconds === undefined ? {} : { uptimeSeconds: parts.uptimeSeconds }),
    ...(parts.connections === undefined ? {} : { connections: parts.connections }),
    ...(parts.maxConnections === undefined ? {} : { maxConnections: parts.maxConnections }),
    ...(parts.sizeBytes === undefined ? {} : { sizeBytes: parts.sizeBytes }),
    ...(parts.rate === undefined ? {} : { rate: parts.rate }),
  };
}

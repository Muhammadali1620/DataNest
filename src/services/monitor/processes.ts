// The sessions of a server and their statements (V8.5), read from the server's own
// list of them, and stopping one: each server lists and kills in its own words.

import { DbError } from '../../core/errors';
import type { Dialect, Session } from '../../drivers/driver';
import type { MonitorServer } from './monitor-server';
import { firstValue, type NamedRow, namedRows, numberOf, textOf } from './rows';

export interface ServerProcess {
  /** How the server names the session: a thread id, a pid, `sid,serial#`, a query id. */
  readonly id: string;
  readonly user?: string;
  /** Where the client connects from. */
  readonly host?: string;
  readonly database?: string;
  readonly application?: string;
  /** What the session does now, in the server's words (`active`, `Sleep`, a wait). */
  readonly state?: string;
  /** For how long it has been doing it. */
  readonly seconds?: number;
  /** The running statement, or the last one of an idle session. */
  readonly query?: string;
  /** Doing nothing: waiting for its client. */
  readonly idle: boolean;
  /** The session the monitor itself reads with. */
  readonly mine: boolean;
  /** The sessions holding what this one waits for. */
  readonly blockedBy?: string;
  /** The id that stops the statement where it is not the session's (CockroachDB). */
  readonly queryId?: string;
}

/** Stop the running statement and keep the session, or close the session. */
export type StopKind = 'cancel' | 'terminate';

/** The longest statement kept per process; the list is read again every few seconds. */
const QUERY_TEXT = 20_000;

const MYSQL_PROCESSES = `SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO,
  CASE WHEN ID = CONNECTION_ID() THEN 1 ELSE 0 END AS MINE
FROM information_schema.PROCESSLIST`;

// The time is that of the statement while it runs and of the state otherwise; who
// blocks whom is asked only of the sessions that wait for a lock, as it takes locks.
const POSTGRES_PROCESSES = `SELECT pid, usename, host(client_addr) AS client_addr, client_port,
  datname, application_name, state, wait_event_type, wait_event,
  EXTRACT(EPOCH FROM (clock_timestamp() - CASE WHEN state = 'active' THEN query_start
    ELSE state_change END)) AS seconds,
  query, CASE WHEN pid = pg_backend_pid() THEN 1 ELSE 0 END AS mine,
  CASE WHEN wait_event_type = 'Lock' THEN array_to_string(pg_blocking_pids(pid), ', ') END
    AS blocked_by
FROM pg_stat_activity
WHERE backend_type = 'client backend'`;

const COCKROACH_PROCESSES = `SELECT s.session_id, s.user_name, s.client_address, s.application_name,
  s.last_active_query, q.query_id, q.query, q.phase,
  EXTRACT(EPOCH FROM (now() - COALESCE(q.start, s.session_start))) AS seconds
FROM crdb_internal.cluster_sessions AS s
LEFT JOIN crdb_internal.cluster_queries AS q ON q.session_id = s.session_id
WHERE s.status <> 'CLOSED'`;

// An idle session shows the last batch it ran, through its connection.
const MSSQL_PROCESSES = `SELECT s.session_id, s.login_name, s.host_name, s.program_name,
  DB_NAME(COALESCE(r.database_id, s.database_id)) AS database_name,
  s.status AS session_status, r.status AS request_status, r.command, r.wait_type,
  r.blocking_session_id,
  DATEDIFF(SECOND, COALESCE(r.start_time, s.last_request_end_time, s.login_time), SYSDATETIME())
    AS seconds,
  t.text AS query_text,
  CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END AS mine
FROM sys.dm_exec_sessions AS s
LEFT JOIN sys.dm_exec_requests AS r ON r.session_id = s.session_id
LEFT JOIN sys.dm_exec_connections AS c ON c.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) AS t
WHERE s.is_user_process = 1`;

// ClickHouse lists the queries that run, the listing itself left out.
const CLICKHOUSE_PROCESSES = `SELECT query_id, user, toString(address) AS address, current_database,
  elapsed, query, is_cancelled, read_rows, memory_usage
FROM system.processes
WHERE query_id != queryID()`;

const ORACLE_PROCESSES = `SELECT s.sid || ',' || s.serial# AS id, s.username, s.machine, s.program,
  s.schemaname, s.status, s.event, s.wait_class, s.last_call_et, q.sql_text,
  s.blocking_session,
  CASE WHEN s.sid = SYS_CONTEXT('USERENV', 'SID') THEN 1 ELSE 0 END AS mine
FROM v$session s
LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number
WHERE s.type = 'USER'`;

export async function listProcesses(
  session: Session,
  server: MonitorServer,
): Promise<ServerProcess[]> {
  switch (server) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
      return unique((await namedRows(session, MYSQL_PROCESSES)).map(mysqlProcess));
    case 'postgres':
      return unique((await namedRows(session, POSTGRES_PROCESSES)).map(postgresProcess));
    case 'cockroach': {
      const mine = await firstValue(session, 'SHOW session_id');
      return unique(
        (await namedRows(session, COCKROACH_PROCESSES)).map((row) => cockroachProcess(row, mine)),
      );
    }
    case 'mssql':
      return unique((await namedRows(session, MSSQL_PROCESSES)).map(mssqlProcess));
    case 'clickhouse':
      return unique((await namedRows(session, CLICKHOUSE_PROCESSES)).map(clickhouseProcess));
    case 'oracle':
      return unique((await namedRows(session, ORACLE_PROCESSES)).map(oracleProcess));
    case 'sqlite':
      throw new DbError('unsupported', 'A SQLite file has no server sessions to list');
  }
}

/**
 * The statement that stops a process listed by `listProcesses`. Ids come from the
 * server, but the page sends them back, so each is checked for its form or quoted.
 */
export function stopStatement(
  server: MonitorServer,
  process: Pick<ServerProcess, 'id' | 'queryId'>,
  kind: StopKind,
  dialect: Pick<Dialect, 'literal'>,
): string {
  switch (server) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
      return `KILL ${kind === 'cancel' ? 'QUERY' : 'CONNECTION'} ${digits(process.id)}`;
    case 'postgres':
      return `SELECT ${kind === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'}(${digits(process.id)})`;
    case 'cockroach':
      if (kind === 'terminate') {
        return `CANCEL SESSION ${dialect.literal(process.id)}`;
      }
      if (process.queryId === undefined) {
        throw new DbError('not-found', 'The session runs no statement now');
      }
      return `CANCEL QUERY ${dialect.literal(process.queryId)}`;
    case 'mssql':
      if (kind === 'cancel') {
        throw new DbError('unsupported', 'SQL Server can only end the whole session');
      }
      return `KILL ${digits(process.id)}`;
    case 'clickhouse':
      if (kind === 'terminate') {
        throw new DbError('unsupported', 'ClickHouse lists queries, not sessions');
      }
      return `KILL QUERY WHERE query_id = ${dialect.literal(process.id)} ASYNC`;
    case 'oracle': {
      const match = /^(\d+),(\d+)$/u.exec(process.id);
      if (match === null) {
        throw new DbError('internal', `"${process.id}" is not an Oracle session id`);
      }
      if (kind === 'cancel') {
        return `ALTER SYSTEM CANCEL SQL '${match[1]}, ${match[2]}'`;
      }
      // A session busy in a call is only marked for kill, and ORA-00031 says so; the
      // thin driver takes that error for a broken connection of its own and drops it.
      return `BEGIN
  EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''${match[1]},${match[2]}'' IMMEDIATE';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE <> -31 THEN
      RAISE;
    END IF;
END;`;
    }
    case 'sqlite':
      throw new DbError('unsupported', 'A SQLite file has no server sessions to stop');
  }
}

/**
 * Stops a process. False when there was nothing to stop: PostgreSQL answers `false`
 * for a process that is gone, ClickHouse and the MySQL family no longer list it.
 */
export async function stopProcess(
  session: Session,
  server: MonitorServer,
  process: Pick<ServerProcess, 'id' | 'queryId'>,
  kind: StopKind,
  dialect: Pick<Dialect, 'literal'>,
): Promise<boolean> {
  const sql = stopStatement(server, process, kind, dialect);
  // ClickHouse's KILL answers as a command, without what it killed, and TiDB's KILL
  // of a finished thread says nothing: ask first, the same for the whole MySQL family.
  const listed =
    server === 'clickhouse'
      ? `SELECT count() FROM system.processes WHERE query_id = ${dialect.literal(process.id)}`
      : server === 'mysql' || server === 'mariadb' || server === 'tidb'
        ? `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID = ${digits(process.id)}`
        : undefined;
  if (listed !== undefined && (await firstValue(session, listed)) === '0') {
    return false;
  }
  const rows = await namedRows(session, sql);
  if (server === 'postgres') {
    return flag(rows[0], kind === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend');
  }
  return true;
}

function mysqlProcess(row: NamedRow): ServerProcess {
  const command = textOf(row, 'command');
  const state = textOf(row, 'state');
  return process({
    id: textOf(row, 'id') ?? '',
    user: textOf(row, 'user'),
    host: textOf(row, 'host'),
    database: textOf(row, 'db'),
    state: [command, state].filter((part) => part !== undefined).join(' · '),
    seconds: numberOf(row, 'time'),
    query: textOf(row, 'info'),
    // Daemons (the event scheduler) wait just as sleeping clients do.
    idle: command === 'Sleep' || command === 'Daemon',
    mine: flag(row, 'mine'),
  });
}

function postgresProcess(row: NamedRow): ServerProcess {
  const state = textOf(row, 'state');
  const address = textOf(row, 'client_addr');
  const port = textOf(row, 'client_port');
  const waitType = textOf(row, 'wait_event_type');
  const wait = textOf(row, 'wait_event');
  return process({
    id: textOf(row, 'pid') ?? '',
    user: textOf(row, 'usename'),
    // A Unix socket has no address and port -1.
    host:
      address === undefined ? (port === '-1' ? 'local' : undefined) : `${address}:${port ?? ''}`,
    database: textOf(row, 'datname'),
    application: textOf(row, 'application_name'),
    state: [state, waitType === undefined ? undefined : `${waitType}: ${wait ?? ''}`]
      .filter((part) => part !== undefined)
      .join(' · '),
    seconds: numberOf(row, 'seconds'),
    query: textOf(row, 'query'),
    idle: state === undefined || state === 'idle',
    mine: flag(row, 'mine'),
    blockedBy: textOf(row, 'blocked_by'),
  });
}

function cockroachProcess(row: NamedRow, mine: string | undefined): ServerProcess {
  const id = textOf(row, 'session_id') ?? '';
  const queryId = textOf(row, 'query_id');
  return process({
    id,
    user: textOf(row, 'user_name'),
    host: textOf(row, 'client_address'),
    application: textOf(row, 'application_name'),
    state: queryId === undefined ? 'idle' : (textOf(row, 'phase') ?? 'executing'),
    seconds: numberOf(row, 'seconds'),
    query: textOf(row, 'query') ?? textOf(row, 'last_active_query'),
    idle: queryId === undefined,
    mine: id === mine,
    queryId,
  });
}

function mssqlProcess(row: NamedRow): ServerProcess {
  const request = textOf(row, 'request_status');
  const blocking = textOf(row, 'blocking_session_id');
  return process({
    id: textOf(row, 'session_id') ?? '',
    user: textOf(row, 'login_name'),
    host: textOf(row, 'host_name'),
    database: textOf(row, 'database_name'),
    application: textOf(row, 'program_name'),
    state: [
      request ?? textOf(row, 'session_status'),
      textOf(row, 'command'),
      textOf(row, 'wait_type'),
    ]
      .filter((part) => part !== undefined)
      .join(' · '),
    seconds: numberOf(row, 'seconds'),
    query: textOf(row, 'query_text'),
    idle: request === undefined,
    mine: flag(row, 'mine'),
    blockedBy: blocking === undefined || blocking === '0' ? undefined : blocking,
  });
}

function clickhouseProcess(row: NamedRow): ServerProcess {
  return process({
    id: textOf(row, 'query_id') ?? '',
    user: textOf(row, 'user'),
    host: textOf(row, 'address'),
    database: textOf(row, 'current_database'),
    state: flag(row, 'is_cancelled') ? 'cancelling' : 'running',
    seconds: numberOf(row, 'elapsed'),
    query: textOf(row, 'query'),
    idle: false,
    mine: false,
  });
}

function oracleProcess(row: NamedRow): ServerProcess {
  const status = textOf(row, 'status');
  const waitClass = textOf(row, 'wait_class');
  const event = waitClass === 'Idle' ? undefined : textOf(row, 'event');
  return process({
    id: textOf(row, 'id') ?? '',
    user: textOf(row, 'username'),
    host: textOf(row, 'machine'),
    database: textOf(row, 'schemaname'),
    application: textOf(row, 'program'),
    state: [status, event].filter((part) => part !== undefined).join(' · '),
    seconds: numberOf(row, 'last_call_et'),
    query: textOf(row, 'sql_text'),
    idle: status !== 'ACTIVE',
    mine: flag(row, 'mine'),
    blockedBy: textOf(row, 'blocking_session'),
  });
}

const TEXT_FIELDS = [
  'user',
  'host',
  'database',
  'application',
  'state',
  'blockedBy',
  'queryId',
] as const;

type ProcessParts = Pick<ServerProcess, 'id' | 'idle' | 'mine'> &
  Partial<Readonly<Record<(typeof TEXT_FIELDS)[number] | 'query', string | undefined>>> & {
    readonly seconds?: number | undefined;
  };

/** A process without its absent fields, its statement cut to a size worth sending. */
function process(parts: ProcessParts): ServerProcess {
  const texts: Partial<Record<(typeof TEXT_FIELDS)[number], string>> = {};
  for (const name of TEXT_FIELDS) {
    const value = parts[name];
    if (value !== undefined && value !== '') {
      texts[name] = value;
    }
  }
  const query = parts.query?.trim() ?? '';
  return {
    id: parts.id,
    idle: parts.idle,
    mine: parts.mine,
    ...texts,
    ...(parts.seconds === undefined ? {} : { seconds: Math.max(0, parts.seconds) }),
    ...(query === ''
      ? {}
      : { query: query.length > QUERY_TEXT ? `${query.slice(0, QUERY_TEXT)}…` : query }),
  };
}

/** One row per session: joins with running statements may repeat a session. */
function unique(processes: readonly ServerProcess[]): ServerProcess[] {
  const seen = new Set<string>();
  return processes.filter((one) => {
    if (one.id === '' || seen.has(one.id)) {
      return false;
    }
    seen.add(one.id);
    return true;
  });
}

function flag(row: NamedRow | undefined, name: string): boolean {
  const text = row === undefined ? undefined : textOf(row, name)?.toLowerCase();
  return text === '1' || text === 'true' || text === 't';
}

function digits(id: string): string {
  if (!/^\d+$/u.test(id)) {
    throw new DbError('internal', `"${id}" is not a process number`);
  }
  return id;
}

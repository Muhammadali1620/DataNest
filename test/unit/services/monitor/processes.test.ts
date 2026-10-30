import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  listProcesses,
  stopProcess,
  stopStatement,
} from '../../../../src/services/monitor/processes';
import type { MonitorServer } from '../../../../src/services/monitor/monitor-server';
import type { CellValue } from '../../../../src/shared/cell-value';
import { records, scriptedSession } from '../../../helpers/scripted-session';

const literal = {
  literal: (value: CellValue) =>
    `'${(typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/gu, "''")}'`,
};

describe('listProcesses', () => {
  it('reads the MySQL process list, marking sleepers idle and its own thread', async () => {
    const { session, executed } = scriptedSession(() =>
      records([
        {
          ID: 7,
          USER: 'app',
          HOST: '10.0.0.5:5122',
          DB: 'shop',
          COMMAND: 'Query',
          TIME: 12,
          STATE: 'executing',
          INFO: 'SELECT SLEEP(30)',
          MINE: 0,
        },
        {
          ID: 8,
          USER: 'app',
          HOST: 'localhost',
          DB: null,
          COMMAND: 'Sleep',
          TIME: 300,
          STATE: '',
          INFO: null,
          MINE: 0,
        },
        {
          ID: 5,
          USER: 'event_scheduler',
          HOST: 'localhost',
          DB: null,
          COMMAND: 'Daemon',
          TIME: 900,
          STATE: 'Waiting on empty queue',
          INFO: null,
          MINE: 0,
        },
        {
          ID: 9,
          USER: 'me',
          HOST: 'localhost',
          DB: 'shop',
          COMMAND: 'Query',
          TIME: 0,
          STATE: 'executing',
          INFO: 'SELECT …',
          MINE: 1,
        },
      ]),
    );
    const processes = await listProcesses(session, 'mysql');
    expect(executed[0]).toContain('information_schema.PROCESSLIST');
    expect(processes[0]).toEqual({
      id: '7',
      user: 'app',
      host: '10.0.0.5:5122',
      database: 'shop',
      state: 'Query · executing',
      seconds: 12,
      query: 'SELECT SLEEP(30)',
      idle: false,
      mine: false,
    });
    expect(processes[1]).toEqual({
      id: '8',
      user: 'app',
      host: 'localhost',
      state: 'Sleep',
      seconds: 300,
      idle: true,
      mine: false,
    });
    expect(processes[2]?.idle).toBe(true);
    expect(processes[3]?.mine).toBe(true);
  });

  it('reads pg_stat_activity: addresses, waits, blockers and sockets', async () => {
    const { session, executed } = scriptedSession(() =>
      records([
        {
          pid: 4100,
          usename: 'app',
          client_addr: '10.0.0.5',
          client_port: 51_000,
          datname: 'shop',
          application_name: 'psql',
          state: 'active',
          wait_event_type: 'Lock',
          wait_event: 'transactionid',
          seconds: { kind: 'decimal', text: '3.250000' },
          query: 'UPDATE orders SET paid = true',
          mine: 0,
          blocked_by: '4101, 4102',
        },
        {
          pid: 4101,
          usename: 'app',
          client_addr: null,
          client_port: -1,
          datname: 'shop',
          application_name: '',
          state: 'idle in transaction',
          wait_event_type: 'Client',
          wait_event: 'ClientRead',
          seconds: 40,
          query: 'UPDATE orders SET paid = false',
          mine: 0,
          blocked_by: null,
        },
        {
          pid: 4102,
          usename: 'app',
          client_addr: null,
          client_port: null,
          datname: 'shop',
          application_name: '',
          state: 'idle',
          wait_event_type: null,
          wait_event: null,
          seconds: -0.001,
          query: '',
          mine: 1,
          blocked_by: null,
        },
      ]),
    );
    const [blocked, socket, idle] = await listProcesses(session, 'postgres');
    expect(executed[0]).toContain("backend_type = 'client backend'");
    expect(blocked).toMatchObject({
      id: '4100',
      host: '10.0.0.5:51000',
      application: 'psql',
      state: 'active · Lock: transactionid',
      seconds: 3.25,
      idle: false,
      blockedBy: '4101, 4102',
    });
    expect(socket).toMatchObject({
      host: 'local',
      idle: false,
      state: 'idle in transaction · Client: ClientRead',
    });
    expect(idle).toMatchObject({ idle: true, mine: true, seconds: 0 });
    expect(idle).not.toHaveProperty('host');
    expect(idle).not.toHaveProperty('query');
  });

  it('reads CockroachDB sessions once each, with the id of the running query', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql === 'SHOW session_id'
        ? records([{ session_id: 'aa01' }])
        : records([
            {
              session_id: 'aa01',
              user_name: 'root',
              client_address: '127.0.0.1:5000',
              application_name: '$ cockroach sql',
              last_active_query: 'SELECT 1',
              query_id: 'q1',
              query: 'SELECT * FROM crdb_internal.cluster_sessions',
              phase: 'executing',
              seconds: 0.01,
            },
            {
              session_id: 'bb02',
              user_name: 'app',
              client_address: '10.0.0.5:5001',
              application_name: '',
              last_active_query: 'SELECT pg_sleep(30)',
              query_id: 'q2',
              query: 'SELECT pg_sleep(30)',
              phase: 'executing',
              seconds: 4,
            },
            {
              session_id: 'bb02',
              user_name: 'app',
              client_address: '10.0.0.5:5001',
              application_name: '',
              last_active_query: 'SELECT pg_sleep(30)',
              query_id: 'q3',
              query: 'SELECT 2',
              phase: 'preparing',
              seconds: 1,
            },
            {
              session_id: 'cc03',
              user_name: 'app',
              client_address: '10.0.0.6:5002',
              application_name: '',
              last_active_query: 'SELECT 3',
              query_id: null,
              query: null,
              phase: null,
              seconds: 60,
            },
          ]),
    );
    const processes = await listProcesses(session, 'cockroach');
    expect(executed[0]).toBe('SHOW session_id');
    expect(processes.map((one) => one.id)).toEqual(['aa01', 'bb02', 'cc03']);
    expect(processes[0]?.mine).toBe(true);
    expect(processes[1]).toMatchObject({ queryId: 'q2', state: 'executing', idle: false });
    expect(processes[2]).toMatchObject({ idle: true, state: 'idle', query: 'SELECT 3' });
    expect(processes[2]).not.toHaveProperty('queryId');
  });

  it('reads SQL Server sessions with their requests and blockers', async () => {
    const { session } = scriptedSession(() =>
      records([
        {
          session_id: 55,
          login_name: 'app',
          host_name: 'web1',
          program_name: 'Microsoft SqlClient',
          database_name: 'shop',
          session_status: 'running',
          request_status: 'suspended',
          command: 'UPDATE',
          wait_type: 'LCK_M_X',
          blocking_session_id: 61,
          seconds: 8,
          query_text: 'UPDATE stock SET n = n - 1',
          mine: 0,
        },
        {
          session_id: 61,
          login_name: 'app',
          host_name: 'web2',
          program_name: null,
          database_name: 'shop',
          session_status: 'sleeping',
          request_status: null,
          command: null,
          wait_type: null,
          blocking_session_id: null,
          seconds: 120,
          query_text: 'BEGIN TRAN; UPDATE stock SET n = 0',
          mine: 0,
        },
        {
          session_id: 70,
          login_name: 'sa',
          host_name: 'me',
          program_name: 'DataNest',
          database_name: 'master',
          session_status: 'running',
          request_status: 'running',
          command: 'SELECT',
          wait_type: null,
          blocking_session_id: 0,
          seconds: 0,
          query_text: 'SELECT …',
          mine: 1,
        },
      ]),
    );
    const [waiting, sleeping, mine] = await listProcesses(session, 'mssql');
    expect(waiting).toMatchObject({
      id: '55',
      state: 'suspended · UPDATE · LCK_M_X',
      blockedBy: '61',
      application: 'Microsoft SqlClient',
      idle: false,
    });
    expect(sleeping).toMatchObject({ state: 'sleeping', idle: true });
    expect(mine).toMatchObject({ mine: true, idle: false });
    expect(mine).not.toHaveProperty('blockedBy');
  });

  it('reads the running queries of ClickHouse, never idle, never its own', async () => {
    const { session, executed } = scriptedSession(() =>
      records([
        {
          query_id: '5c1e-…',
          user: 'default',
          address: '::ffff:127.0.0.1',
          current_database: 'default',
          elapsed: 2.5,
          query: 'SELECT count() FROM numbers(1e10)',
          is_cancelled: 1,
          read_rows: { kind: 'bigint', text: '123456' },
          memory_usage: 1000,
        },
      ]),
    );
    const [query] = await listProcesses(session, 'clickhouse');
    expect(executed[0]).toContain('queryID()');
    expect(query).toMatchObject({
      id: '5c1e-…',
      state: 'cancelling',
      seconds: 2.5,
      idle: false,
      mine: false,
    });
  });

  it('reads Oracle sessions: sid and serial, waits that are not idle, blockers', async () => {
    const { session } = scriptedSession(() =>
      records([
        {
          ID: '23,4411',
          USERNAME: 'APP',
          MACHINE: 'web1',
          PROGRAM: 'node',
          SCHEMANAME: 'APP',
          STATUS: 'ACTIVE',
          EVENT: 'enq: TX - row lock contention',
          WAIT_CLASS: 'Application',
          LAST_CALL_ET: 15,
          SQL_TEXT: 'UPDATE t SET x = 1',
          BLOCKING_SESSION: 31,
          MINE: 0,
        },
        {
          ID: '31,9',
          USERNAME: 'APP',
          MACHINE: 'web2',
          PROGRAM: 'node',
          SCHEMANAME: 'APP',
          STATUS: 'INACTIVE',
          EVENT: 'SQL*Net message from client',
          WAIT_CLASS: 'Idle',
          LAST_CALL_ET: 200,
          SQL_TEXT: null,
          BLOCKING_SESSION: null,
          MINE: 1,
        },
      ]),
    );
    const [active, inactive] = await listProcesses(session, 'oracle');
    expect(active).toMatchObject({
      id: '23,4411',
      state: 'ACTIVE · enq: TX - row lock contention',
      blockedBy: '31',
      idle: false,
    });
    expect(inactive).toMatchObject({ state: 'INACTIVE', idle: true, mine: true });
  });

  it('cuts a very long statement and drops rows without an id', async () => {
    const long = 'x'.repeat(25_000);
    const { session } = scriptedSession(() =>
      records([
        { pid: 1, state: 'active', query: `  ${long}  `, mine: 0 },
        { pid: null, state: 'active', query: 'SELECT 1', mine: 0 },
      ]),
    );
    const processes = await listProcesses(session, 'postgres');
    expect(processes).toHaveLength(1);
    expect(processes[0]?.query).toHaveLength(20_001);
    expect(processes[0]?.query?.endsWith('…')).toBe(true);
  });

  it('refuses SQLite, which has no server', async () => {
    const { session, executed } = scriptedSession(() => []);
    await expect(listProcesses(session, 'sqlite')).rejects.toMatchObject({ code: 'unsupported' });
    expect(executed).toEqual([]);
  });

  it('passes errors of the server on', async () => {
    const { session } = scriptedSession(() => new DbError('permission-denied', 'no V$SESSION'));
    await expect(listProcesses(session, 'oracle')).rejects.toThrow('no V$SESSION');
  });
});

describe('stopStatement', () => {
  const cases: [MonitorServer, 'cancel' | 'terminate', string][] = [
    ['mysql', 'cancel', 'KILL QUERY 42'],
    ['mariadb', 'terminate', 'KILL CONNECTION 42'],
    ['tidb', 'cancel', 'KILL QUERY 42'],
    ['postgres', 'cancel', 'SELECT pg_cancel_backend(42)'],
    ['postgres', 'terminate', 'SELECT pg_terminate_backend(42)'],
    ['mssql', 'terminate', 'KILL 42'],
  ];
  it.each(cases)('%s %s', (server, kind, sql) => {
    expect(stopStatement(server, { id: '42' }, kind, literal)).toBe(sql);
  });

  it('quotes CockroachDB and ClickHouse ids', () => {
    expect(stopStatement('cockroach', { id: "s'1", queryId: 'q1' }, 'cancel', literal)).toBe(
      "CANCEL QUERY 'q1'",
    );
    expect(stopStatement('cockroach', { id: "s'1" }, 'terminate', literal)).toBe(
      "CANCEL SESSION 's''1'",
    );
    expect(stopStatement('clickhouse', { id: "a'b" }, 'cancel', literal)).toBe(
      "KILL QUERY WHERE query_id = 'a''b' ASYNC",
    );
  });

  it('cancels and kills Oracle sessions, a session only marked for kill counting as done', () => {
    expect(stopStatement('oracle', { id: '23,4411' }, 'cancel', literal)).toBe(
      "ALTER SYSTEM CANCEL SQL '23, 4411'",
    );
    const kill = stopStatement('oracle', { id: '23,4411' }, 'terminate', literal);
    expect(kill).toContain("ALTER SYSTEM KILL SESSION ''23,4411'' IMMEDIATE");
    expect(kill).toContain('SQLCODE <> -31');
  });

  it('refuses ids of the wrong form, so nothing else reaches the SQL', () => {
    for (const server of ['mysql', 'postgres', 'mssql'] as const) {
      expect(() => stopStatement(server, { id: '1; DROP TABLE x' }, 'terminate', literal)).toThrow(
        DbError,
      );
    }
    expect(() => stopStatement('oracle', { id: "1,2' --" }, 'terminate', literal)).toThrow(
      'not an Oracle session id',
    );
  });

  it('refuses what a server cannot do', () => {
    expect(() => stopStatement('mssql', { id: '1' }, 'cancel', literal)).toThrow('whole session');
    expect(() => stopStatement('clickhouse', { id: 'q' }, 'terminate', literal)).toThrow(
      'not sessions',
    );
    expect(() => stopStatement('cockroach', { id: 's' }, 'cancel', literal)).toThrow(
      'runs no statement',
    );
    expect(() => stopStatement('sqlite', { id: '1' }, 'cancel', literal)).toThrow(DbError);
  });
});

describe('stopProcess', () => {
  it('reports what pg_cancel_backend answers', async () => {
    for (const answer of [true, false]) {
      const { session } = scriptedSession(() => records([{ pg_cancel_backend: answer }]));
      expect(await stopProcess(session, 'postgres', { id: '5' }, 'cancel', literal)).toBe(answer);
    }
  });

  it('asks the MySQL family and ClickHouse first whether the process still runs', async () => {
    for (const server of ['mysql', 'tidb', 'clickhouse'] as const) {
      const id = server === 'clickhouse' ? 'q1' : '5';
      const gone = scriptedSession(() => records([{ n: 0 }]));
      expect(await stopProcess(gone.session, server, { id }, 'cancel', literal)).toBe(false);
      expect(gone.executed).toHaveLength(1);
      const running = scriptedSession((sql) => (sql.includes('KILL') ? [] : records([{ n: 1 }])));
      expect(await stopProcess(running.session, server, { id }, 'cancel', literal)).toBe(true);
      expect(running.executed[1]).toContain('KILL');
    }
  });

  it('passes the refusal of the server on', async () => {
    const { session } = scriptedSession(() => new DbError('permission-denied', 'not allowed'));
    await expect(stopProcess(session, 'mssql', { id: '5' }, 'terminate', literal)).rejects.toThrow(
      'not allowed',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { Session } from '../../../../src/drivers/driver';
import type { CellValue } from '../../../../src/shared/cell-value';
import type { SqlDriverId } from '../../../../src/shared/connection';
import {
  ServerMonitorModel,
  type ServerMonitorModelDeps,
} from '../../../../src/vscode/panels/server-monitor-model';
import { records, type ScriptedReply, scriptedSession } from '../../../helpers/scripted-session';

const literal = {
  literal: (value: CellValue) => `'${typeof value === 'string' ? value : JSON.stringify(value)}'`,
};

const PG_PROCESSES = records([
  { pid: 10, usename: 'app', state: 'active', query: 'SELECT pg_sleep(9)', mine: 0 },
  { pid: 11, usename: 'me', state: 'active', query: 'SELECT …', mine: 1 },
]);

function model(
  answer: (sql: string) => ScriptedReply | Promise<ScriptedReply>,
  overrides: Partial<ServerMonitorModelDeps> & { driver?: SqlDriverId } = {},
) {
  const scripted = scriptedSession(answer);
  let opened = 0;
  let clock = 1_000_000;
  const monitor = new ServerMonitorModel({
    connectionName: 'Local',
    driver: 'postgres',
    dialect: literal,
    readOnly: false,
    session: async (): Promise<Session> => {
      opened += 1;
      return await Promise.resolve(scripted.session);
    },
    now: () => clock,
    ...overrides,
  });
  return {
    monitor,
    executed: scripted.executed,
    get opened() {
      return opened;
    },
    tick(ms: number) {
      clock += ms;
    },
  };
}

function postgres(sql: string): ScriptedReply {
  if (sql === 'SELECT version()') {
    return records([{ version: 'PostgreSQL 17.6' }]);
  }
  if (sql.includes('pg_stat_activity') && sql.includes('pid,')) {
    return PG_PROCESSES;
  }
  if (sql.includes('pg_cancel_backend') || sql.includes('pg_terminate_backend')) {
    return records([
      { [sql.includes('cancel') ? 'pg_cancel_backend' : 'pg_terminate_backend']: true },
    ]);
  }
  return [];
}

describe('ServerMonitorModel', () => {
  it('finds out the server first and shows what it can do', async () => {
    const { monitor } = model(postgres);
    expect(monitor.started).toBe(false);
    expect(monitor.state()).toEqual({ connectionName: 'Local', readOnly: false });
    await monitor.start();
    expect(monitor.started).toBe(true);
    expect(monitor.state()).toEqual({
      connectionName: 'Local',
      readOnly: false,
      server: 'PostgreSQL',
      features: {
        processes: true,
        cancel: true,
        terminate: true,
        scopes: ['session'],
        serverScope: 'server',
      },
    });
  });

  it('shows a failure to connect on the page and reads nothing then', async () => {
    const { monitor } = model(() => new DbError('auth-failed', 'password authentication failed'));
    await monitor.start();
    expect(monitor.started).toBe(true);
    expect(monitor.state().error).toBe('password authentication failed');
    await expect(monitor.processes()).rejects.toMatchObject({ code: 'busy' });
  });

  it('refuses to read before the server is known', async () => {
    const { monitor } = model(postgres);
    await expect(monitor.status()).rejects.toThrow('still connecting');
  });

  it('lists processes, keeping the id of the running statement to itself', async () => {
    const { monitor } = model((sql) =>
      sql === 'SHOW session_id'
        ? records([{ session_id: 'me' }])
        : sql.includes('cluster_sessions')
          ? records([{ session_id: 's1', query_id: 'q1', query: 'SELECT 1', seconds: 1 }])
          : records([{ version: 'CockroachDB CCL v24.3.6' }]),
    );
    await monitor.start();
    const { rows, at } = await monitor.processes();
    expect(at).toBe(1_000_000);
    expect(rows).toEqual([
      { id: 's1', state: 'executing', seconds: 1, query: 'SELECT 1', idle: false, mine: false },
    ]);
    expect(monitor.process('s1')?.queryId).toBe('q1');
  });

  it('reads settings only of the scopes the server has', async () => {
    const { monitor, executed } = model((sql) =>
      sql.includes('pg_settings')
        ? records([{ name: 'work_mem', setting: '4096', source: 'default' }])
        : postgres(sql),
    );
    await monitor.start();
    expect(await monitor.settings('session')).toEqual([{ name: 'work_mem', value: '4096' }]);
    await expect(monitor.settings('server')).rejects.toMatchObject({ code: 'unsupported' });
    expect(executed.filter((sql) => sql.includes('pg_settings'))).toHaveLength(1);
  });

  it('works out the change per second of each number and the rate between readings', async () => {
    let questions = 1000;
    let threads = 4;
    const reading = model(
      (sql) => {
        if (sql === 'SELECT VERSION()') {
          return records([{ version: '8.4.6' }]);
        }
        if (sql === 'SHOW GLOBAL STATUS') {
          return records([
            { Variable_name: 'Questions', Value: String(questions) },
            { Variable_name: 'Threads_connected', Value: String(threads) },
            { Variable_name: 'Uptime', Value: '100' },
            { Variable_name: 'Ssl_version', Value: 'TLSv1.3' },
          ]);
        }
        return records([{ version: '8.4.6', max_connections: 151 }]);
      },
      { driver: 'mysql' },
    );
    const { monitor } = reading;
    await monitor.start();
    const first = await monitor.status();
    expect(first.rows.every((row) => row.perSecond === undefined)).toBe(true);
    expect(first.summary).not.toHaveProperty('rate');
    expect(first.summary).toMatchObject({ version: '8.4.6', connections: 4, maxConnections: 151 });

    reading.tick(2000);
    questions = 1100;
    threads = 2;
    const second = await monitor.status();
    expect(second.rows.find((row) => row.name === 'Questions')?.perSecond).toBe(50);
    expect(second.rows.find((row) => row.name === 'Threads_connected')?.perSecond).toBe(-1);
    // Unchanged numbers and texts have no rate.
    expect(second.rows.find((row) => row.name === 'Uptime')).not.toHaveProperty('perSecond');
    expect(second.rows.find((row) => row.name === 'Ssl_version')).not.toHaveProperty('perSecond');
    expect(second.summary.rate).toEqual({ kind: 'queries', perSecond: 50 });

    // A restarted server counts from zero: no rate until the next reading.
    reading.tick(1000);
    questions = 10;
    expect((await monitor.status()).summary).not.toHaveProperty('rate');
    reading.tick(1000);
    questions = 20;
    expect((await monitor.status()).summary.rate).toEqual({ kind: 'queries', perSecond: 10 });
  });

  it('gives no rate when two readings come at the same moment', async () => {
    let commits = 1;
    const { monitor } = model((sql) => {
      if (sql.includes('pg_stat_database')) {
        commits += 1;
        return records([{ xact_commit: commits, xact_rollback: 0 }]);
      }
      return postgres(sql);
    });
    await monitor.start();
    await monitor.status();
    const second = await monitor.status();
    expect(second.summary).not.toHaveProperty('rate');
    expect(second.rows.every((row) => row.perSecond === undefined)).toBe(true);
  });

  it('stops another process of the last list', async () => {
    const { monitor, executed } = model(postgres);
    await monitor.start();
    await monitor.processes();
    expect(await monitor.stop('10', 'cancel')).toBe(true);
    expect(await monitor.stop('10', 'terminate')).toBe(true);
    expect(executed.slice(-2)).toEqual([
      'SELECT pg_cancel_backend(10)',
      'SELECT pg_terminate_backend(10)',
    ]);
  });

  it('refuses to stop its own session, an unlisted process, or anything when read-only', async () => {
    const { monitor } = model(postgres);
    await monitor.start();
    await monitor.processes();
    await expect(monitor.stop('11', 'cancel')).rejects.toThrow('monitor itself');
    await expect(monitor.stop('99', 'cancel')).rejects.toMatchObject({ code: 'not-found' });

    const readOnly = model(postgres, { readOnly: true }).monitor;
    await readOnly.start();
    await readOnly.processes();
    expect(readOnly.state().readOnly).toBe(true);
    await expect(readOnly.stop('10', 'cancel')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('refuses a way of stopping the server does not have', async () => {
    const { monitor } = model(
      () => records([{ session_id: 5, request_status: 'running', mine: 0 }]),
      {
        driver: 'mssql',
      },
    );
    await monitor.start();
    await monitor.processes();
    await expect(monitor.stop('5', 'cancel')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reads one thing at a time on its one session', async () => {
    let running = 0;
    let most = 0;
    const { monitor } = model(async (sql) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return sql.includes('pg_settings') ? [] : postgres(sql);
    });
    await monitor.start();
    const failing = monitor.settings('server');
    await Promise.all([
      monitor.processes(),
      monitor.settings('session'),
      expect(failing).rejects.toThrow(),
      monitor.processes(),
    ]);
    expect(most).toBe(1);
  });

  it('goes on after a failed read', async () => {
    let fail = true;
    const { monitor } = model((sql) => {
      if (sql.includes('pg_stat_activity') && fail) {
        fail = false;
        return new DbError('timeout', 'slow');
      }
      return postgres(sql);
    });
    await monitor.start();
    await expect(monitor.processes()).rejects.toThrow('slow');
    expect((await monitor.processes()).rows).toHaveLength(2);
  });
});

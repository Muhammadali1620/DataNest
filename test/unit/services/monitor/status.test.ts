import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { readStatus } from '../../../../src/services/monitor/status';
import { records, scriptedSession } from '../../../helpers/scripted-session';

describe('readStatus', () => {
  it('reads MySQL global status with uptime, threads, the limit and questions', async () => {
    const { session } = scriptedSession((sql) =>
      sql === 'SHOW GLOBAL STATUS'
        ? records([
            { Variable_name: 'Uptime', Value: '3600' },
            { Variable_name: 'Threads_connected', Value: '4' },
            { Variable_name: 'Questions', Value: '1200' },
            { Variable_name: 'Ssl_cipher', Value: '' },
          ])
        : records([{ version: '8.4.6', max_connections: { kind: 'bigint', text: '151' } }]),
    );
    const status = await readStatus(session, 'mysql');
    expect(status.values).toHaveLength(4);
    expect(status.values[3]).toEqual({ name: 'Ssl_cipher', value: '' });
    expect(status.summary).toEqual({
      version: '8.4.6',
      uptimeSeconds: 3600,
      connections: 4,
      maxConnections: 151,
      rate: { kind: 'queries', total: 1200 },
    });
  });

  it('adds PostgreSQL database counters up, with the writer and transactions as the rate', async () => {
    const { session, executed } = scriptedSession((sql) => {
      if (sql.includes('pg_stat_database')) {
        return records([
          {
            numbackends: 3,
            xact_commit: { kind: 'decimal', text: '100' },
            xact_rollback: 5,
            deadlocks: 0,
          },
        ]);
      }
      if (sql.includes('pg_stat_bgwriter')) {
        return records([
          { buffers_clean: 7, stats_reset: { kind: 'datetime', text: '2026-10-30 08:00:00+00' } },
        ]);
      }
      return records([
        { version: '17.6', uptime: 120.5, connections: 3, max_connections: '100', size: 7_000_000 },
      ]);
    });
    const status = await readStatus(session, 'postgres');
    expect(executed[0]).toContain('sum(xact_commit) AS xact_commit');
    expect(status.values).toContainEqual({
      name: 'xact_commit',
      value: '100',
      group: 'pg_stat_database',
    });
    expect(status.values).toContainEqual({
      name: 'tup_inserted',
      value: '',
      group: 'pg_stat_database',
    });
    expect(status.values).toContainEqual({
      name: 'buffers_clean',
      value: '7',
      group: 'pg_stat_bgwriter',
    });
    expect(status.summary).toEqual({
      version: '17.6',
      uptimeSeconds: 120.5,
      connections: 3,
      maxConnections: 100,
      sizeBytes: 7_000_000,
      rate: { kind: 'transactions', total: 105 },
    });
  });

  it('gives no PostgreSQL rate when a counter is missing', async () => {
    const { session } = scriptedSession((sql) =>
      sql.includes('pg_stat_database')
        ? records([{ xact_commit: 1 }])
        : sql.includes('bgwriter')
          ? []
          : records([{ version: '11.2-YB' }]),
    );
    const status = await readStatus(session, 'postgres');
    expect(status.summary).toEqual({ version: '11.2-YB' });
  });

  it('reads CockroachDB node metrics and the short version', async () => {
    const { session } = scriptedSession((sql) =>
      sql.includes('node_metrics')
        ? records([
            { name: 'sys.uptime', value: 60 },
            { name: 'sql.conns', value: 2 },
            { name: 'sql.query.count', value: 77 },
          ])
        : records([{ version: 'CockroachDB CCL v24.3.6 (x86_64-pc-linux-gnu, built 2025/02/20)' }]),
    );
    expect((await readStatus(session, 'cockroach')).summary).toEqual({
      version: 'v24.3.6',
      uptimeSeconds: 60,
      connections: 2,
      rate: { kind: 'queries', total: 77 },
    });
  });

  it('reads SQL Server counters by object, batch requests as the rate', async () => {
    const { session } = scriptedSession((sql) =>
      sql.includes('dm_os_performance_counters')
        ? records([
            {
              object_name: 'SQLServer:SQL Statistics',
              counter_name: 'Batch Requests/sec',
              cntr_value: 900,
            },
            {
              object_name: 'MSSQL$NAMED:General Statistics',
              counter_name: 'User Connections',
              cntr_value: 3,
            },
          ])
        : records([
            {
              version: '16.0.4215.2 Developer Edition (64-bit)',
              uptime: 50,
              connections: 3,
              max_connections: 32_767,
            },
          ]),
    );
    const status = await readStatus(session, 'mssql');
    expect(status.values).toEqual([
      { name: 'Batch Requests/sec', value: '900', group: 'SQL Statistics' },
      { name: 'User Connections', value: '3', group: 'General Statistics' },
    ]);
    expect(status.summary).toMatchObject({
      uptimeSeconds: 50,
      maxConnections: 32_767,
      rate: { kind: 'queries', total: 900 },
    });
  });

  it('reads ClickHouse metrics, events and asynchronous metrics; connections add up', async () => {
    const { session } = scriptedSession((sql) =>
      sql.includes('system.metrics')
        ? records([
            { grp: 'metrics', name: 'TCPConnection', value: '2' },
            { grp: 'metrics', name: 'HTTPConnection', value: '1' },
            { grp: 'metrics', name: 'Query', value: '1' },
            { grp: 'asynchronous_metrics', name: 'Uptime', value: '30' },
          ])
        : records([{ version: '25.8.3.3', uptime: 30 }]),
    );
    const status = await readStatus(session, 'clickhouse');
    expect(status.values[2]).toEqual({ name: 'Query', value: '1', group: 'metrics' });
    // No `Query` event yet: a fresh server has run nothing.
    expect(status.summary).toEqual({
      version: '25.8.3.3',
      uptimeSeconds: 30,
      connections: 3,
      rate: { kind: 'queries', total: 0 },
    });
  });

  it('reads Oracle system statistics with the execute count as the rate', async () => {
    const { session } = scriptedSession((sql) =>
      sql.includes('v$sysstat')
        ? records([
            { NAME: 'execute count', VALUE: 5000 },
            { NAME: 'user commits', VALUE: 10 },
          ])
        : records([
            { VERSION: '23.26.0.0.0', UPTIME: 900, CONNECTIONS: 4, MAX_CONNECTIONS: '472' },
          ]),
    );
    expect((await readStatus(session, 'oracle')).summary).toEqual({
      version: '23.26.0.0.0',
      uptimeSeconds: 900,
      connections: 4,
      maxConnections: 472,
      rate: { kind: 'queries', total: 5000 },
    });
  });

  it('reads the pages of a SQLite file and its size', async () => {
    const { session } = scriptedSession(() =>
      records([{ version: '3.50.4', page_count: 10, page_size: 4096, freelist_count: 2 }]),
    );
    const status = await readStatus(session, 'sqlite');
    expect(status.values.map((one) => one.name)).toEqual([
      'page_count',
      'page_size',
      'freelist_count',
    ]);
    expect(status.summary).toEqual({ version: '3.50.4', sizeBytes: 40_960 });
  });

  it('passes errors on', async () => {
    const { session } = scriptedSession(
      () => new DbError('permission-denied', 'VIEW SERVER STATE'),
    );
    await expect(readStatus(session, 'mssql')).rejects.toThrow('VIEW SERVER STATE');
  });
});

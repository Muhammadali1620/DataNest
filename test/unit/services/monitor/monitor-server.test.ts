import { describe, expect, it } from 'vitest';
import {
  type MonitorServer,
  monitorFeatures,
  monitorServerOf,
  SERVER_NAMES,
} from '../../../../src/services/monitor/monitor-server';
import { records, scriptedSession } from '../../../helpers/scripted-session';

describe('monitorServerOf', () => {
  it('tells the servers of one driver apart by their version', async () => {
    const cases: [string, 'mysql' | 'postgres', MonitorServer][] = [
      ['8.4.6', 'mysql', 'mysql'],
      ['5.7.44', 'mysql', 'mysql'],
      ['11.4.8-MariaDB', 'mysql', 'mariadb'],
      ['8.0.11-TiDB-v8.5.1', 'mysql', 'tidb'],
      ['PostgreSQL 17.6', 'postgres', 'postgres'],
      ['CockroachDB CCL v24.3.6', 'postgres', 'cockroach'],
    ];
    for (const [version, driver, server] of cases) {
      const { session } = scriptedSession(() => records([{ version }]));
      expect(await monitorServerOf(session, driver), version).toBe(server);
    }
  });

  it('needs no question where the driver is the server', async () => {
    const { session, executed } = scriptedSession(() => []);
    for (const driver of ['sqlite', 'mssql', 'clickhouse', 'oracle'] as const) {
      expect(await monitorServerOf(session, driver)).toBe(driver);
    }
    expect(executed).toEqual([]);
  });
});

describe('monitorFeatures', () => {
  it('lists processes everywhere but in a SQLite file', () => {
    for (const server of Object.keys(SERVER_NAMES) as MonitorServer[]) {
      expect(monitorFeatures(server).processes, server).toBe(server !== 'sqlite');
      expect(monitorFeatures(server).scopes[0]).toBe('session');
    }
  });

  it('cannot cancel only a SQL Server batch, nor end a ClickHouse session', () => {
    expect(monitorFeatures('mssql')).toMatchObject({ cancel: false, terminate: true });
    expect(monitorFeatures('clickhouse')).toMatchObject({ cancel: true, terminate: false });
    expect(monitorFeatures('postgres')).toMatchObject({ cancel: true, terminate: true });
  });

  it('names the server side of settings as the server does', () => {
    expect(monitorFeatures('mysql').serverScope).toBe('global');
    expect(monitorFeatures('cockroach').serverScope).toBe('cluster');
    expect(monitorFeatures('oracle').serverScope).toBe('system');
    expect(monitorFeatures('postgres').scopes).toEqual(['session']);
    expect(monitorFeatures('mssql').scopes).toEqual(['session', 'server']);
  });
});

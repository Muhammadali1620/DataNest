// The server monitor (V8.5) on the core servers and SQLite.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { serverConfig } from '../../helpers/explain-suite';
import { monitorSuite } from '../../helpers/monitor-suite';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-monitor-'));
}, 60_000);

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const mysqlSlow = (marker: string): string => `SELECT SLEEP(30), '${marker}'`;

monitorSuite({
  label: 'mysql',
  driver: () => mysqlDriver,
  config: () => serverConfig('mysql', 'mysql'),
  server: 'mysql',
  sqlDriver: 'mysql',
  slow: mysqlSlow,
  settings: { session: 'autocommit', server: 'max_connections' },
  summary: ['uptimeSeconds', 'connections', 'maxConnections'],
});

monitorSuite({
  label: 'mariadb',
  driver: () => mysqlDriver,
  config: () => serverConfig('mariadb', 'mysql'),
  server: 'mariadb',
  sqlDriver: 'mysql',
  slow: mysqlSlow,
  settings: { session: 'autocommit', server: 'max_connections' },
  summary: ['uptimeSeconds', 'connections', 'maxConnections'],
});

monitorSuite({
  label: 'postgres',
  driver: () => postgresDriver,
  config: () => serverConfig('postgres', 'postgres'),
  server: 'postgres',
  sqlDriver: 'postgres',
  slow: (marker) => `SELECT pg_sleep(30), '${marker}'`,
  settings: { session: 'work_mem' },
  summary: ['uptimeSeconds', 'connections', 'maxConnections', 'sizeBytes'],
});

monitorSuite({
  label: 'sqlite',
  driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
  config: () => ({
    id: 'monitor-sqlite',
    name: 'sqlite',
    driver: 'sqlite',
    file: join(dir, 'monitor.db'),
  }),
  server: 'sqlite',
  sqlDriver: 'sqlite',
  settings: { session: 'page_size' },
  summary: ['sizeBytes'],
});

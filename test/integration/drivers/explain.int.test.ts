// EXPLAIN (V8.2) on the core servers and SQLite.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { explainSuite, serverConfig } from '../../helpers/explain-suite';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-explain-'));
}, 60_000);

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const CHANGE = "UPDATE customers SET full_name = full_name WHERE country = 'XX'";

explainSuite({
  label: 'mysql',
  driver: () => mysqlDriver,
  config: () => serverConfig('mysql', 'mysql'),
  server: 'mysql',
  sqlDriver: 'mysql',
  change: CHANGE,
});

explainSuite({
  label: 'mariadb',
  driver: () => mysqlDriver,
  config: () => serverConfig('mariadb', 'mysql'),
  server: 'mariadb',
  sqlDriver: 'mysql',
  change: CHANGE,
});

explainSuite({
  label: 'postgres',
  driver: () => postgresDriver,
  config: () => serverConfig('postgres', 'postgres'),
  server: 'postgres',
  sqlDriver: 'postgres',
  change: CHANGE,
});

explainSuite({
  label: 'sqlite',
  driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
  config: () => ({
    id: 'explain-sqlite',
    name: 'sqlite',
    driver: 'sqlite',
    file: join(dir, 'explain.db'),
  }),
  setup: [
    'CREATE TABLE customers (id INTEGER PRIMARY KEY, full_name TEXT, country TEXT)',
    'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers (id))',
    'CREATE INDEX ix_orders_customer ON orders (customer_id)',
    "INSERT INTO customers VALUES (1, 'Alice', 'US')",
    'INSERT INTO orders VALUES (1, 1)',
  ],
  server: 'sqlite',
  sqlDriver: 'sqlite',
  change: CHANGE,
});

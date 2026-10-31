// "Duplicate Table…" (V10.2.3) on MySQL, MariaDB, PostgreSQL and a SQLite file; the
// checks are in helpers/duplicate-suite.ts, shared with the other server groups.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { type DuplicatePlace, duplicateSuite } from '../../helpers/duplicate-suite';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker | undefined;
const dir = mkdtempSync(join(tmpdir(), 'datanest-duplicate-'));

beforeAll(async () => {
  worker = await buildSqliteWorker();
});

afterAll(() => {
  worker?.dispose();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const same = (table: string): string => table;
const dropIfExists = (table: string): string[] => [`DROP TABLE IF EXISTS ${table}`];

function mysqlPlace(id: Extract<TestDatabaseId, 'mysql' | 'mariadb'>): DuplicatePlace {
  return {
    label: id,
    driver: () => mysqlDriver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `dup-${id}`,
        name: id,
        driver: 'mysql',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: 'datanest_empty',
      };
    },
    scope: { database: 'datanest_empty' },
    create: [
      `CREATE TABLE staff (
         id int AUTO_INCREMENT PRIMARY KEY,
         name varchar(50) NOT NULL,
         boss int NULL,
         KEY staff_name_idx (name),
         CONSTRAINT staff_boss_fk FOREIGN KEY (boss) REFERENCES staff (id))`,
      "INSERT INTO staff (name, boss) VALUES ('Ann', NULL), ('Bob', 1), ('Cy', 1)",
    ],
    drop: dropIfExists,
    name: same,
    reported: same,
    keys: true,
  };
}

duplicateSuite(mysqlPlace('mysql'));
duplicateSuite(mysqlPlace('mariadb'));

duplicateSuite({
  label: 'postgres',
  driver: () => postgresDriver,
  config: () => {
    const db = testDatabase('postgres');
    return {
      id: 'dup-postgres',
      name: 'postgres',
      driver: 'postgres',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: 'datanest_empty',
    };
  },
  scope: { database: 'datanest_empty', schema: 'public' },
  create: [
    `CREATE TABLE staff (
       id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       name text NOT NULL,
       boss integer REFERENCES staff (id))`,
    'CREATE INDEX staff_name_idx ON staff (name)',
    "INSERT INTO staff (name, boss) VALUES ('Ann', NULL), ('Bob', 1), ('Cy', 1)",
  ],
  drop: dropIfExists,
  name: same,
  reported: same,
  keys: true,
});

duplicateSuite({
  label: 'sqlite',
  driver: () => {
    if (worker === undefined) {
      throw new Error('The SQLite worker is not built yet');
    }
    return createSqliteDriver({ workerPath: worker.workerPath });
  },
  config: () => ({ id: 'dup-sqlite', name: 's', driver: 'sqlite', file: join(dir, 'dup.db') }),
  scope: {},
  create: [
    `CREATE TABLE staff (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       boss INTEGER REFERENCES staff (id))`,
    'CREATE INDEX staff_name_idx ON staff (name)',
    "INSERT INTO staff (name, boss) VALUES ('Ann', NULL), ('Bob', 1), ('Cy', 1)",
  ],
  drop: dropIfExists,
  name: same,
  reported: same,
  keys: true,
});

// Comparing schemas on real servers (V8.3): the differences between two schemas, and
// the round trip that proves the script — run it on the target, compare again, and
// nothing is left to change.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import {
  type CompareSide,
  type CompareTarget,
  compareRoundTrip,
} from '../../helpers/compare-roundtrip';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-compare-'));
}, 60_000);

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function mysqlSide(id: TestDatabaseId, database: string, setup: string[]): CompareSide {
  return {
    config: () => {
      const db = testDatabase(id);
      return {
        id: `cmp-${id}-${database}`,
        name: id,
        driver: 'mysql',
        host: db.host,
        port: db.port,
        user: 'root',
        password: 'datanest_root',
        // Not there yet: the setup creates it.
      };
    },
    scope: { database },
    setup,
  };
}

const MYSQL_SOURCE = [
  'DROP DATABASE IF EXISTS dn_cmp_src',
  'CREATE DATABASE dn_cmp_src',
  'USE dn_cmp_src',
  'CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, email VARCHAR(100))',
  `CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2),
     KEY ix_orders_customer (customer_id),
     CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id))`,
  `CREATE TABLE notes (id INT PRIMARY KEY, customer_id INT,
     CONSTRAINT fk_notes_customer FOREIGN KEY (customer_id) REFERENCES customers (id))`,
  'CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100',
];
const MYSQL_TARGET = [
  'DROP DATABASE IF EXISTS dn_cmp_dst',
  'CREATE DATABASE dn_cmp_dst',
  'USE dn_cmp_dst',
  'CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(20), phone VARCHAR(20))',
  'CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(8,2))',
  'CREATE TABLE legacy (id INT PRIMARY KEY)',
  'CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 50',
];

function mysqlTarget(id: TestDatabaseId): CompareTarget {
  return {
    label: id,
    driverId: 'mysql',
    driver: () => mysqlDriver,
    source: mysqlSide(id, 'dn_cmp_src', MYSQL_SOURCE),
    target: mysqlSide(id, 'dn_cmp_dst', MYSQL_TARGET),
    teardown: ['DROP DATABASE IF EXISTS dn_cmp_src', 'DROP DATABASE IF EXISTS dn_cmp_dst'],
  };
}

function postgresSide(schema: string, setup: string[]): CompareSide {
  return {
    config: () => {
      const db = testDatabase('postgres');
      return {
        id: `cmp-pg-${schema}`,
        name: 'postgres',
        driver: 'postgres',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
      };
    },
    scope: { schema },
    setup,
  };
}

const TARGETS: readonly CompareTarget[] = [
  mysqlTarget('mysql'),
  mysqlTarget('mariadb'),
  {
    label: 'postgres',
    driverId: 'postgres',
    driver: () => postgresDriver,
    source: postgresSide('cmp_src', [
      'DROP SCHEMA IF EXISTS cmp_src CASCADE',
      'CREATE SCHEMA cmp_src',
      'CREATE TABLE cmp_src.customers (id int PRIMARY KEY, name varchar(50) NOT NULL, email varchar(100))',
      `CREATE TABLE cmp_src.orders (id int PRIMARY KEY, customer_id int NOT NULL, total numeric(10,2),
         CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES cmp_src.customers (id))`,
      'CREATE INDEX ix_orders_customer ON cmp_src.orders (customer_id)',
      `CREATE TABLE cmp_src.notes (id int PRIMARY KEY, customer_id int,
         CONSTRAINT fk_notes_customer FOREIGN KEY (customer_id) REFERENCES cmp_src.customers (id))`,
      'CREATE VIEW cmp_src.big_orders AS SELECT id, total FROM cmp_src.orders WHERE total > 100',
      `CREATE FUNCTION cmp_src.order_count(p int) RETURNS bigint LANGUAGE sql AS
         'SELECT count(*) FROM cmp_src.orders WHERE customer_id = p'`,
    ]),
    target: postgresSide('cmp_dst', [
      'DROP SCHEMA IF EXISTS cmp_dst CASCADE',
      'CREATE SCHEMA cmp_dst',
      'CREATE TABLE cmp_dst.customers (id int PRIMARY KEY, name varchar(20), phone varchar(20))',
      'CREATE TABLE cmp_dst.orders (id int PRIMARY KEY, customer_id int NOT NULL, total numeric(8,2))',
      'CREATE TABLE cmp_dst.legacy (id int PRIMARY KEY)',
      'CREATE VIEW cmp_dst.big_orders AS SELECT id, total FROM cmp_dst.orders WHERE total > 50',
    ]),
    teardown: ['DROP SCHEMA IF EXISTS cmp_src CASCADE', 'DROP SCHEMA IF EXISTS cmp_dst CASCADE'],
  },
  {
    label: 'sqlite',
    driverId: 'sqlite',
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    source: {
      config: () => ({
        id: 'cmp-sqlite-src',
        name: 'src',
        driver: 'sqlite',
        file: join(dir, 'src.db'),
      }),
      scope: {},
      setup: [
        'CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, email VARCHAR(100))',
        `CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, total DECIMAL(10,2),
           CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id))`,
        'CREATE INDEX ix_orders_customer ON orders (customer_id)',
        `CREATE TABLE notes (id INTEGER PRIMARY KEY, customer_id INTEGER,
           CONSTRAINT fk_notes_customer FOREIGN KEY (customer_id) REFERENCES customers (id))`,
        'CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100',
      ],
    },
    target: {
      config: () => ({
        id: 'cmp-sqlite-dst',
        name: 'dst',
        driver: 'sqlite',
        file: join(dir, 'dst.db'),
      }),
      scope: {},
      setup: [
        'CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR(20), phone VARCHAR(20))',
        'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, total DECIMAL(8,2))',
        'CREATE TABLE legacy (id INTEGER PRIMARY KEY)',
        'CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 50',
      ],
    },
    teardown: [],
  },
];

for (const target of TARGETS) {
  compareRoundTrip(target);
}

// Comparing schemas on SQL Server (V8.3): two schemas of one database, and the script
// that makes the second like the first.

import { driver } from '../../../src/drivers/mssql';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { compareRoundTrip } from '../../helpers/compare-roundtrip';
import { testDatabase } from '../../helpers/databases';

function config(): ResolvedConnectionConfig {
  const db = testDatabase('mssql');
  return {
    id: 'cmp-mssql',
    name: 'mssql',
    driver: 'mssql',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

/** Drops what a schema holds, then the schema; SQL Server has no DROP SCHEMA … CASCADE. */
const drop = (schema: string): string[] => [
  `DROP VIEW IF EXISTS ${schema}.big_orders`,
  `DROP TABLE IF EXISTS ${schema}.notes`,
  `DROP TABLE IF EXISTS ${schema}.orders`,
  `DROP TABLE IF EXISTS ${schema}.customers`,
  `DROP TABLE IF EXISTS ${schema}.legacy`,
  `DROP SCHEMA IF EXISTS ${schema}`,
];

compareRoundTrip({
  label: 'mssql',
  driverId: 'mssql',
  driver: () => driver,
  source: {
    config,
    scope: { database: testDatabase('mssql').database, schema: 'cmp_src' },
    setup: [
      ...drop('cmp_src'),
      'CREATE SCHEMA cmp_src',
      'CREATE TABLE cmp_src.customers (id int PRIMARY KEY, name nvarchar(50) NOT NULL, email nvarchar(100))',
      `CREATE TABLE cmp_src.orders (id int PRIMARY KEY, customer_id int NOT NULL, total decimal(10,2),
         CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES cmp_src.customers (id))`,
      'CREATE INDEX ix_orders_customer ON cmp_src.orders (customer_id)',
      `CREATE TABLE cmp_src.notes (id int PRIMARY KEY, customer_id int,
         CONSTRAINT fk_notes_customer FOREIGN KEY (customer_id) REFERENCES cmp_src.customers (id))`,
      'CREATE VIEW cmp_src.big_orders AS SELECT id, total FROM cmp_src.orders WHERE total > 100',
    ],
  },
  target: {
    config,
    scope: { database: testDatabase('mssql').database, schema: 'cmp_dst' },
    setup: [
      ...drop('cmp_dst'),
      'CREATE SCHEMA cmp_dst',
      'CREATE TABLE cmp_dst.customers (id int PRIMARY KEY, name nvarchar(20), phone nvarchar(20))',
      'CREATE TABLE cmp_dst.orders (id int PRIMARY KEY, customer_id int NOT NULL, total decimal(8,2))',
      'CREATE TABLE cmp_dst.legacy (id int PRIMARY KEY)',
      'CREATE VIEW cmp_dst.big_orders AS SELECT id, total FROM cmp_dst.orders WHERE total > 50',
    ],
  },
  teardown: [...drop('cmp_src'), ...drop('cmp_dst')],
});

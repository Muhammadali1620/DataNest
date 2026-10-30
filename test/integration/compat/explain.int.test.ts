// EXPLAIN (V8.2) on the compatible servers: TiDB's table, CockroachDB's text tree and
// YugabyteDB's PostgreSQL JSON.

import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { explainSuite, serverConfig } from '../../helpers/explain-suite';

const CHANGE = "UPDATE customers SET full_name = full_name WHERE country = 'XX'";

explainSuite({
  label: 'tidb',
  driver: () => mysqlDriver,
  config: () => serverConfig('tidb', 'mysql'),
  server: 'tidb',
  sqlDriver: 'mysql',
  change: CHANGE,
});

explainSuite({
  label: 'cockroach',
  driver: () => postgresDriver,
  config: () => serverConfig('cockroach', 'postgres'),
  server: 'cockroach',
  sqlDriver: 'postgres',
  change: CHANGE,
});

explainSuite({
  label: 'yugabyte',
  driver: () => postgresDriver,
  config: () => serverConfig('yugabyte', 'postgres'),
  server: 'postgres',
  sqlDriver: 'postgres',
  change: CHANGE,
});

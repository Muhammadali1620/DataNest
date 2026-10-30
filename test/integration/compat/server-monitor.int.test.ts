// The server monitor (V8.5) on the compatible servers: TiDB lists like MySQL,
// CockroachDB has its own cluster sessions, YugabyteDB is PostgreSQL.

import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { serverConfig } from '../../helpers/explain-suite';
import { monitorSuite } from '../../helpers/monitor-suite';

monitorSuite({
  label: 'tidb',
  driver: () => mysqlDriver,
  config: () => serverConfig('tidb', 'mysql'),
  server: 'tidb',
  sqlDriver: 'mysql',
  slow: (marker) => `SELECT SLEEP(30), '${marker}'`,
  settings: { session: 'autocommit', server: 'max_connections' },
  summary: [],
});

monitorSuite({
  label: 'cockroach',
  driver: () => postgresDriver,
  config: () => serverConfig('cockroach', 'postgres'),
  server: 'cockroach',
  sqlDriver: 'postgres',
  slow: (marker) => `SELECT pg_sleep(30), '${marker}'`,
  settings: { session: 'application_name', server: 'sql.defaults.distsql' },
  summary: ['uptimeSeconds', 'connections'],
});

monitorSuite({
  label: 'yugabyte',
  driver: () => postgresDriver,
  config: () => serverConfig('yugabyte', 'postgres'),
  server: 'postgres',
  sqlDriver: 'postgres',
  slow: (marker) => `SELECT pg_sleep(30), '${marker}'`,
  settings: { session: 'work_mem' },
  // YugabyteDB answers NULL for the size of a database.
  summary: ['uptimeSeconds', 'connections', 'maxConnections'],
});

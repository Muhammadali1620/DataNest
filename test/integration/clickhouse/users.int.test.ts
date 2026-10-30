// Users and privileges (V8.6) on ClickHouse, whose test user manages access with SQL.

import { driver } from '../../../src/drivers/clickhouse';
import { serverConfig } from '../../helpers/explain-suite';
import { usersSuite } from '../../helpers/users-suite';

usersSuite({
  label: 'clickhouse',
  driver: () => driver,
  config: () => serverConfig('clickhouse', 'clickhouse'),
  server: 'clickhouse',
  known: 'datanest',
  table: { database: 'datanest_test', name: 'customers' },
  role: {
    create: (name) => `CREATE ROLE ${name}`,
    drop: (name) => `DROP ROLE ${name}`,
  },
  read: 'SELECT id FROM datanest_test.customers',
});

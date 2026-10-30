// Users and privileges (V8.6) on the compatible servers. CockroachDB runs insecure in
// the tests, where accounts have no passwords and log in as they are; YugabyteDB
// trusts every login there.

import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { serverConfig } from '../../helpers/explain-suite';
import { usersSuite } from '../../helpers/users-suite';

usersSuite({
  label: 'tidb',
  driver: () => mysqlDriver,
  config: () => serverConfig('tidb', 'mysql'),
  server: 'tidb',
  known: 'root',
  table: { database: 'datanest_test', name: 'customers' },
  role: {
    create: (name) => `CREATE ROLE '${name}'`,
    drop: (name) => `DROP ROLE '${name}'`,
  },
  read: 'SELECT id FROM datanest_test.customers',
});

usersSuite({
  label: 'cockroach',
  driver: () => postgresDriver,
  config: () => serverConfig('cockroach', 'postgres'),
  server: 'cockroach',
  known: 'root',
  table: { schema: 'public', name: 'customers' },
  role: {
    create: (name) => `CREATE ROLE "${name}"`,
    drop: (name) => `DROP ROLE "${name}"`,
  },
  login: false,
});

usersSuite({
  label: 'yugabyte',
  driver: () => postgresDriver,
  config: () => serverConfig('yugabyte', 'postgres'),
  server: 'postgres',
  known: 'yugabyte',
  passwords: false,
  table: { schema: 'public', name: 'customers' },
  role: {
    create: (name) => `CREATE ROLE "${name}"`,
    drop: (name) => `DROP ROLE "${name}"`,
  },
  read: 'SELECT id FROM public.customers',
});

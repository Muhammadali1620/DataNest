// Users and privileges (V8.6) on the core servers, as their administrators.

import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { serverConfig } from '../../helpers/explain-suite';
import { usersSuite } from '../../helpers/users-suite';

const mysqlRole = {
  create: (name: string) => `CREATE ROLE '${name}'`,
  drop: (name: string) => `DROP ROLE '${name}'`,
};

usersSuite({
  label: 'mysql',
  driver: () => mysqlDriver,
  config: () => ({ ...serverConfig('mysql', 'mysql'), user: 'root', password: 'datanest_root' }),
  server: 'mysql',
  known: 'datanest',
  table: { database: 'datanest_test', name: 'customers' },
  role: mysqlRole,
  read: 'SELECT id FROM datanest_test.customers',
});

usersSuite({
  label: 'mariadb',
  driver: () => mysqlDriver,
  config: () => ({ ...serverConfig('mariadb', 'mysql'), user: 'root', password: 'datanest_root' }),
  server: 'mariadb',
  known: 'datanest',
  table: { database: 'datanest_test', name: 'customers' },
  role: mysqlRole,
  read: 'SELECT id FROM datanest_test.customers',
});

usersSuite({
  label: 'postgres',
  driver: () => postgresDriver,
  config: () => serverConfig('postgres', 'postgres'),
  server: 'postgres',
  known: 'datanest',
  table: { schema: 'public', name: 'customers' },
  role: {
    create: (name) => `CREATE ROLE "${name}"`,
    drop: (name) => `DROP ROLE "${name}"`,
  },
  read: 'SELECT id FROM public.customers',
});

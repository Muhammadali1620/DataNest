// Users and privileges (V8.6) on SQL Server, as `sa`, in the test database: a login and
// a user of the same name, permissions on a table, database roles.

import { driver } from '../../../src/drivers/mssql';
import { serverConfig } from '../../helpers/explain-suite';
import { usersSuite } from '../../helpers/users-suite';

usersSuite({
  label: 'mssql',
  driver: () => driver,
  config: () => ({ ...serverConfig('mssql', 'mssql'), user: 'sa', password: 'Datanest_Root1' }),
  server: 'mssql',
  known: 'datanest',
  table: { schema: 'dbo', name: 'customers' },
  role: {
    create: (name) => `CREATE ROLE [${name}]`,
    drop: (name) => `DROP ROLE [${name}]`,
  },
  read: 'SELECT id FROM dbo.customers',
});

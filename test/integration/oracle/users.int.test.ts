// Users and privileges (V8.6) on Oracle, as SYSTEM in the pluggable database.

import { driver } from '../../../src/drivers/oracle';
import { serverConfig } from '../../helpers/explain-suite';
import { usersSuite } from '../../helpers/users-suite';

usersSuite({
  label: 'oracle',
  driver: () => driver,
  config: () => ({
    ...serverConfig('oracle', 'oracle'),
    user: 'system',
    password: 'datanest_root',
  }),
  server: 'oracle',
  known: 'DATANEST',
  table: { schema: 'DATANEST', name: 'CUSTOMERS' },
  role: {
    create: (name) => `CREATE ROLE "${name}"`,
    drop: (name) => `DROP ROLE "${name}"`,
  },
  read: 'SELECT id FROM datanest.customers',
});

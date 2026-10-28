// MySQL / MariaDB driver. Bundled separately (dist/drivers/mysql.js) and loaded
// on the first MySQL connection (ARCHITECTURE.md §7).

import type { Driver } from '../driver';
import { mysqlDialect } from './dialect';
import { openMysqlSession } from './session';

export const driver: Driver = {
  id: 'mysql',
  dialect: mysqlDialect,
  capabilities: {
    databases: true,
    schemas: false,
    databaseScopedSessions: false,
    cancel: true,
    objectKinds: ['function', 'procedure', 'event'],
  },
  openSession: openMysqlSession,
};

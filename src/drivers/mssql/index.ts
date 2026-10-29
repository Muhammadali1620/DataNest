// Microsoft SQL Server driver (V6.2), through tedious. Bundled separately
// (dist/drivers/mssql.js) and loaded on the first SQL Server connection (§7).

import type { Driver } from '../driver';
import { mssqlDialect } from './dialect';
import { openMssqlSession } from './session';

export const driver: Driver = {
  id: 'mssql',
  dialect: mssqlDialect,
  capabilities: {
    databases: true,
    schemas: true,
    // A session reads the catalogs of its own database, so the tree keeps one per
    // database, as for PostgreSQL (D28).
    databaseScopedSessions: true,
    cancel: true,
    transactions: true,
    objectKinds: ['function', 'procedure', 'sequence'],
  },
  openSession: openMssqlSession,
};

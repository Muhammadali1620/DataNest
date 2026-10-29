// PostgreSQL driver. Bundled separately (dist/drivers/postgres.js) and loaded
// on the first PostgreSQL connection (ARCHITECTURE.md §7).

import type { Driver } from '../driver';
import { postgresDialect } from './dialect';
import { openPostgresSession } from './session';

export const driver: Driver = {
  id: 'postgres',
  dialect: postgresDialect,
  capabilities: {
    databases: true,
    schemas: true,
    databaseScopedSessions: true,
    cancel: true,
    transactions: true,
    objectKinds: ['function', 'procedure', 'sequence'],
  },
  openSession: openPostgresSession,
};

// Oracle Database driver (V6.4), node-oracledb in thin mode: no Instant Client, no native
// code. Bundled separately (dist/drivers/oracle.js) and loaded on the first connection.

import type { Driver } from '../driver';
import { oracleDialect } from './dialect';
import { openOracleSession } from './session';

export const driver: Driver = {
  id: 'oracle',
  dialect: oracleDialect,
  capabilities: {
    // The database is the service the connection opens: the tree shows it, with its
    // schemas under it, and a session reads only that one (as in PostgreSQL).
    databases: true,
    schemas: true,
    databaseScopedSessions: true,
    cancel: true,
    transactions: true,
    objectKinds: ['function', 'procedure', 'sequence'],
  },
  openSession: openOracleSession,
};

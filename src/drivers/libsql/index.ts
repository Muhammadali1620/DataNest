// libSQL over HTTP (V13.17): sqld and Turso speak the Hrana protocol; the SQL they run is
// SQLite's, so quoting, DDL, dumps and the catalog queries are the SQLite driver's.
// Bundled separately (dist/drivers/libsql.js) and loaded on first use.

import type { ResolvedConnectionConfig } from '../../shared/connection';
import type { Driver, Session } from '../driver';
import { sqliteDialect } from '../sqlite/dialect';
import { openLibsqlSession } from './session';

export const driver: Driver = {
  id: 'libsql',
  dialect: sqliteDialect,
  capabilities: {
    databases: false,
    schemas: false,
    databaseScopedSessions: false,
    // The request is aborted; the server gives up the statement with its connection.
    cancel: true,
    transactions: true,
    objectKinds: [],
  },
  openSession: (config: ResolvedConnectionConfig): Promise<Session> => openLibsqlSession(config),
};

// Grafana Loki over its HTTP API (V13.25): LogQL through `/loki/api/v1/query_range`, labels as
// tables and their values as columns. Bundled separately (dist/drivers/loki.js) and loaded on
// first use.

import type { ResolvedConnectionConfig } from '../../shared/connection';
import type { Driver, Session } from '../driver';
import { lokiDialect } from './dialect';
import { openLokiSession } from './session';

export const driver: Driver = {
  id: 'loki',
  dialect: lokiDialect,
  capabilities: {
    // No databases: a tenant is a header, and the labels are listed under the connection.
    databases: false,
    schemas: false,
    databaseScopedSessions: false,
    // The request is aborted; Loki stops a query whose client has gone away.
    cancel: true,
    transactions: false,
    objectKinds: [],
  },
  openSession: (config: ResolvedConnectionConfig): Promise<Session> => openLokiSession(config),
};

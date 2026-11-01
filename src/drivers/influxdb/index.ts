// InfluxDB 2.x over HTTP (V13.20): Flux through `/api/v2/query` and InfluxQL through
// `/query`, buckets as databases and measurements as tables. Bundled separately
// (dist/drivers/influxdb.js) and loaded on first use.

import type { ResolvedConnectionConfig } from '../../shared/connection';
import type { Driver, Session } from '../driver';
import { influxdbDialect } from './dialect';
import { openInfluxSession } from './session';

export const driver: Driver = {
  id: 'influxdb',
  dialect: influxdbDialect,
  capabilities: {
    // Buckets are the databases; InfluxQL runs on one bucket per session (its `db`).
    databases: true,
    schemas: false,
    databaseScopedSessions: true,
    // The request is aborted; the server stops the query when its client is gone.
    cancel: true,
    transactions: false,
    objectKinds: [],
  },
  openSession: (config: ResolvedConnectionConfig): Promise<Session> => openInfluxSession(config),
};

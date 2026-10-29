// ClickHouse driver (V6.3), over the HTTP interface with @clickhouse/client. Bundled
// separately (dist/drivers/clickhouse.js) and loaded on the first ClickHouse connection.

import type { Driver } from '../driver';
import { clickhouseDialect } from './dialect';
import { openClickhouseSession } from './session';

export const driver: Driver = {
  id: 'clickhouse',
  dialect: clickhouseDialect,
  capabilities: {
    databases: true,
    schemas: false,
    // One session reads every database by naming it, as in MySQL.
    databaseScopedSessions: false,
    cancel: true,
    transactions: false,
    objectKinds: [],
  },
  openSession: openClickhouseSession,
};

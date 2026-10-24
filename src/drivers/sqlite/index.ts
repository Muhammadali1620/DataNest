// SQLite driver on node:sqlite inside a worker thread (D5, D23). Bundled separately
// (dist/drivers/sqlite.js + sqlite-worker.js) and loaded on first use.

import type { ResolvedConnectionConfig } from '../../core/model/connection';
import type { Driver, Session } from '../driver';
import { sqliteDialect } from './dialect';
import { openSqliteSession, type SqliteSessionOptions } from './session';

/** `options.workerPath` lets tests point at a worker bundle built on the fly. */
export function createSqliteDriver(options: SqliteSessionOptions = {}): Driver {
  return {
    id: 'sqlite',
    dialect: sqliteDialect,
    capabilities: { databases: false, schemas: false, cancel: true },
    openSession: (config: ResolvedConnectionConfig): Promise<Session> =>
      openSqliteSession(config, options),
  };
}

export const driver: Driver = createSqliteDriver();

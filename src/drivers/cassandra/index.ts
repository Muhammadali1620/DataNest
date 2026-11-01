// Apache Cassandra (V13.22): the CQL native protocol through the official pure-JS driver,
// keyspaces as databases, tables and materialized views in the tree. Bundled separately
// (dist/drivers/cassandra.js) and loaded on first use.

import type { ResolvedConnectionConfig } from '../../shared/connection';
import type { Driver, Session } from '../driver';
import { cassandraDialect } from './dialect';
import { openCassandraSession } from './session';

export const driver: Driver = {
  id: 'cassandra',
  dialect: cassandraDialect,
  capabilities: {
    // Keyspaces are the databases; names are written `keyspace.table`, so one session reads all.
    databases: true,
    schemas: false,
    databaseScopedSessions: false,
    // The driver cannot stop a request on its way: the page in flight finishes, its rows are
    // dropped and no further page is asked for.
    cancel: true,
    // A BATCH is not a transaction: nothing can be rolled back.
    transactions: false,
    objectKinds: ['function'],
  },
  openSession: (config: ResolvedConnectionConfig): Promise<Session> => openCassandraSession(config),
};

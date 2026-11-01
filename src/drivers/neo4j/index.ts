// Neo4j (V13.21): the Query API over HTTP, Cypher in the editor, labels and relationship types
// in the tree. Bundled separately (dist/drivers/neo4j.js) and loaded on first use.

import type { ResolvedConnectionConfig } from '../../shared/connection';
import type { Driver, Session } from '../driver';
import { neo4jDialect } from './dialect';
import { openNeo4jSession } from './session';

export const driver: Driver = {
  id: 'neo4j',
  dialect: neo4jDialect,
  capabilities: {
    databases: true,
    schemas: false,
    // The database is part of the request address: another one needs another session.
    databaseScopedSessions: true,
    // The request is aborted; the server stops the statement with its transaction.
    cancel: true,
    // Each statement is a transaction of its own (the Query API has no open ones).
    transactions: false,
    objectKinds: [],
  },
  openSession: (config: ResolvedConnectionConfig): Promise<Session> => openNeo4jSession(config),
};

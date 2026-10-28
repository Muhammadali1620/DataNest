// The session the tree and other browsing features share, so expanding a node,
// reading a definition or running a quick DDL statement never opens a connection
// of its own per click.

import type { Session } from '../drivers/driver';
import { ConnectionManager } from './connection-manager';

/**
 * The browsing session of a connection. The database is part of the target only
 * for drivers whose session cannot look outside its own database (PostgreSQL);
 * elsewhere one session serves every database and is never reopened while browsing.
 */
export async function browseSession(
  manager: Pick<ConnectionManager, 'acquire' | 'driverOf'>,
  connectionId: string,
  database?: string,
): Promise<Session> {
  const { capabilities } = await manager.driverOf(connectionId);
  const scoped = capabilities.databaseScopedSessions && database !== undefined;
  return await manager.acquire(
    ConnectionManager.treeOwner(connectionId, scoped ? database : undefined),
    scoped ? { connectionId, database } : { connectionId },
  );
}

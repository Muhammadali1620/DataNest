// Creating, renaming, emptying and dropping databases, schemas, tables and other
// objects. The SQL comes from the dialect and is always shown before it runs
// (ARCHITECTURE.md §8); this module builds it and runs exactly what was shown.

import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { ObjectRef, RelationKind, TableRef } from '../core/model/objects';
import type { SchemaDdl, Session } from '../drivers/driver';
import { browseSession } from './browse-session';
import { ConnectionManager } from './connection-manager';

export type SchemaAction =
  | { readonly kind: 'createDatabase'; readonly name: string }
  | { readonly kind: 'dropDatabase'; readonly name: string }
  | { readonly kind: 'createSchema'; readonly database?: string; readonly name: string }
  | {
      readonly kind: 'dropSchema';
      readonly database?: string;
      readonly name: string;
      readonly cascade: boolean;
    }
  | { readonly kind: 'createTable'; readonly table: TableRef }
  | { readonly kind: 'dropTable'; readonly table: TableRef; readonly relation: RelationKind }
  | {
      readonly kind: 'renameTable';
      readonly table: TableRef;
      readonly relation: RelationKind;
      readonly newName: string;
    }
  | { readonly kind: 'truncateTable'; readonly table: TableRef }
  | { readonly kind: 'dropObject'; readonly object: ObjectRef };

/** The statement of an action; `unsupported` when this database has no such thing. */
export function actionSql(action: SchemaAction, ddl: SchemaDdl): string {
  switch (action.kind) {
    case 'createDatabase':
      return required(
        ddl.createDatabase,
        'This connection has no databases to create',
      )(action.name);
    case 'dropDatabase':
      return required(ddl.dropDatabase, 'This connection has no databases to drop')(action.name);
    case 'createSchema':
      return required(ddl.createSchema, 'This database has no schemas')(action.name);
    case 'dropSchema':
      return required(ddl.dropSchema, 'This database has no schemas')(action.name, action.cascade);
    case 'createTable':
      return ddl.createTableStub(action.table);
    case 'dropTable':
      return ddl.dropRelation(action.table, action.relation);
    case 'renameTable':
      return ddl.renameRelation(action.table, action.relation, action.newName);
    case 'truncateTable':
      return ddl.truncateTable(action.table);
    case 'dropObject':
      return ddl.dropObject(action.object);
  }
}

function required<T>(method: T | undefined, message: string): T {
  if (method === undefined) {
    throw new DbError('unsupported', message);
  }
  return method;
}

/**
 * The database whose session runs an action. Databases are created and dropped from
 * the connection's own database: PostgreSQL cannot drop the one a session sits in.
 */
export function actionDatabase(action: SchemaAction): string | undefined {
  switch (action.kind) {
    case 'createDatabase':
    case 'dropDatabase':
      return undefined;
    case 'createSchema':
    case 'dropSchema':
      return action.database;
    case 'createTable':
    case 'dropTable':
    case 'renameTable':
    case 'truncateTable':
      return action.table.database;
    case 'dropObject':
      return action.object.database;
  }
}

export interface SchemaActionsDeps {
  readonly manager: Pick<ConnectionManager, 'acquire' | 'driverOf' | 'release'>;
  /** Dropped after every action: the structure has changed. */
  readonly cache: { invalidate(connectionId?: string): void };
  readonly logger: Logger;
}

export class SchemaActions {
  private readonly logger: Logger;

  constructor(private readonly deps: SchemaActionsDeps) {
    this.logger = deps.logger.child('schema');
  }

  /** The SQL the user will see and confirm. */
  async sqlOf(connectionId: string, action: SchemaAction): Promise<string> {
    const driver = await this.deps.manager.driverOf(connectionId);
    return actionSql(action, driver.dialect.ddl);
  }

  /** Runs the confirmed SQL on the browsing session of the right database. */
  async run(connectionId: string, action: SchemaAction, sql: string): Promise<void> {
    if (action.kind === 'dropDatabase') {
      // The tree's own session inside that database would keep it busy.
      await this.deps.manager.release(ConnectionManager.treeOwner(connectionId, action.name));
    }
    const session = await browseSession(this.deps.manager, connectionId, actionDatabase(action));
    try {
      await drain(session, sql);
      this.logger.info(`${action.kind} done on ${connectionId}`);
    } finally {
      // Even a failed statement may have changed something (MySQL DDL is not atomic).
      this.deps.cache.invalidate(connectionId);
    }
  }
}

async function drain(session: Session, sql: string): Promise<void> {
  for await (const _event of session.execute(sql)) {
    // DDL returns no rows worth keeping; reaching the end means it ran.
  }
}

// Creating, renaming, emptying and dropping databases, schemas, tables and other
// objects. The SQL comes from the dialect and is always shown before it runs
// (ARCHITECTURE.md §8); this module builds it and runs exactly what was shown.

import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { ObjectRef, ObjectScope, RelationKind, TableRef } from '../core/model/objects';
import type { SchemaDdl, Session } from '../drivers/driver';
import type { TableBackground, TableDesign } from '../shared/table-design';
import { browseSession } from './browse-session';
import { ConnectionManager } from './connection-manager';
import { msg } from '../core/user-message';

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
  /** `table` is the scope and `design.name` the name of the new table. */
  | { readonly kind: 'createTable'; readonly table: TableRef; readonly design: TableDesign }
  /** An edited definition (`statements`) put in place of `object`, defined as `original`. */
  | {
      readonly kind: 'replaceObject';
      readonly object: ObjectRef;
      readonly statements: readonly string[];
      readonly original: readonly string[];
    }
  /** `table` names the table as it is now; `before` is the design it was loaded with. */
  | {
      readonly kind: 'alterTable';
      readonly table: TableRef;
      readonly before: TableDesign;
      readonly after: TableDesign;
      readonly background: TableBackground;
    }
  | { readonly kind: 'dropTable'; readonly table: TableRef; readonly relation: RelationKind }
  | {
      readonly kind: 'renameTable';
      readonly table: TableRef;
      readonly relation: RelationKind;
      readonly newName: string;
    }
  | { readonly kind: 'truncateTable'; readonly table: TableRef }
  | { readonly kind: 'dropObject'; readonly object: ObjectRef }
  /** Statements built elsewhere (a CHECK constraint of the table page), run in `scope`. */
  | {
      readonly kind: 'runStatements';
      readonly scope: ObjectScope;
      readonly statements: readonly string[];
    };

/** The statements of an action; `unsupported` when this database has no such thing. */
export function actionSql(action: SchemaAction, ddl: SchemaDdl): string[] {
  if (action.kind === 'createTable') {
    return ddl.createTable(action.table, action.design);
  }
  if (action.kind === 'alterTable') {
    return [...alterPlan(action, ddl).statements];
  }
  if (action.kind === 'runStatements') {
    return [...action.statements];
  }
  if (action.kind === 'replaceObject') {
    // The checks run first and are shown too: everything that runs is shown (§8).
    const plan = replacePlan(action, ddl);
    return [...plan.check, ...plan.statements];
  }
  return [singleStatement(action, ddl)];
}

function replacePlan(action: Extract<SchemaAction, { kind: 'replaceObject' }>, ddl: SchemaDdl) {
  return ddl.replaceObject(action.object, action.statements, action.original);
}

/** The leading statements of an action that only try the change out. */
export function actionChecks(action: SchemaAction, ddl: SchemaDdl): readonly string[] {
  return action.kind === 'replaceObject' ? replacePlan(action, ddl).check : [];
}

function alterPlan(action: Extract<SchemaAction, { kind: 'alterTable' }>, ddl: SchemaDdl) {
  return ddl.alterTable(action.table, action.before, action.after, action.background);
}

/** What to run after a failed statement, so nothing is left half done or switched on. */
export function actionRecovery(action: SchemaAction, ddl: SchemaDdl): readonly string[] {
  if (action.kind === 'alterTable') {
    return alterPlan(action, ddl).recovery;
  }
  return action.kind === 'replaceObject' ? replacePlan(action, ddl).recovery : [];
}

/** A script of statements as the user sees it and as it opens in an editor. */
export function actionScript(statements: readonly string[]): string {
  return statements.map((statement) => `${statement};`).join('\n\n');
}

function singleStatement(
  action: Exclude<
    SchemaAction,
    { kind: 'createTable' | 'alterTable' | 'replaceObject' | 'runStatements' }
  >,
  ddl: SchemaDdl,
): string {
  switch (action.kind) {
    case 'createDatabase':
      return required(
        ddl.createDatabase,
        msg('This connection has no databases to create'),
      )(action.name);
    case 'dropDatabase':
      return required(
        ddl.dropDatabase,
        msg('This connection has no databases to drop'),
      )(action.name);
    case 'createSchema':
      return required(ddl.createSchema, msg('This database has no schemas'))(action.name);
    case 'dropSchema':
      return required(ddl.dropSchema, msg('This database has no schemas'))(
        action.name,
        action.cascade,
      );
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
    case 'alterTable':
    case 'createTable':
    case 'dropTable':
    case 'renameTable':
    case 'truncateTable':
      return action.table.database;
    case 'dropObject':
    case 'replaceObject':
      return action.object.database;
    case 'runStatements':
      return action.scope.database;
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

  /** The statements the user will see and confirm. */
  async sqlOf(connectionId: string, action: SchemaAction): Promise<string[]> {
    const driver = await this.deps.manager.driverOf(connectionId);
    return actionSql(action, driver.dialect.ddl);
  }

  /** Runs the confirmed statements, in order, on the browsing session of the right database. */
  async run(
    connectionId: string,
    action: SchemaAction,
    statements: readonly string[],
  ): Promise<void> {
    if (action.kind === 'dropDatabase') {
      // The tree's own session inside that database would keep it busy.
      await this.deps.manager.release(ConnectionManager.treeOwner(connectionId, action.name));
    }
    const session = await browseSession(this.deps.manager, connectionId, actionDatabase(action));
    const { ddl } = (await this.deps.manager.driverOf(connectionId)).dialect;
    const checks = actionChecks(action, ddl).length;
    let done = 0;
    try {
      for (const statement of statements) {
        await drain(session, statement);
        done += 1;
      }
      this.logger.info(`${action.kind} done on ${connectionId}`);
    } catch (error) {
      // A failed check has changed nothing: only its scratch object may need to go.
      const recovery =
        done < checks ? actionChecks(action, ddl).slice(-1) : actionRecovery(action, ddl);
      await this.recover(session, recovery);
      throw error;
    } finally {
      // Even a failed statement may have changed something (MySQL DDL is not atomic).
      this.deps.cache.invalidate(connectionId);
    }
  }

  /** Rolls back what a failed plan started; a failure here is logged, the first one wins. */
  private async recover(session: Session, statements: readonly string[]): Promise<void> {
    for (const statement of statements) {
      try {
        await drain(session, statement);
      } catch (error) {
        this.logger.warn(`Recovery statement failed: ${statement}`, error);
      }
    }
  }
}

async function drain(session: Session, sql: string): Promise<void> {
  for await (const _event of session.execute(sql)) {
    // DDL returns no rows worth keeping; reaching the end means it ran.
  }
}

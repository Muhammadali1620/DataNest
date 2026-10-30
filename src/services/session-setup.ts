// What every new session runs before anyone uses it (V4.9): the time zone, then the
// connection's init SQL. Failing here fails the connect, with the statement named,
// because a session without its settings would quietly answer differently.

import { DbError, errorMessage, toDbError } from '../core/errors';
import { isReadOnlyStatement } from '../core/sql/read-only';
import { splitStatements } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import type { Dialect, Session } from '../drivers/driver';
import { type ConnectionInput, optionSupport } from '../shared/connection';
import { msg } from '../core/user-message';

export interface SetupStatement {
  readonly sql: string;
  readonly origin: 'time-zone' | 'init';
}

/**
 * The statements in the order they run. A read-only connection may not change
 * anything from its init SQL either — `SET SESSION TRANSACTION READ WRITE` there
 * would lift the guard the session was opened with (V4.6).
 */
export function setupStatements(config: ConnectionInput, dialect: Dialect): SetupStatement[] {
  const statements: SetupStatement[] = [];
  const zone = config.options?.timeZone;
  if (zone !== undefined && optionSupport(config.driver).timeZone && dialect.setTimeZone) {
    statements.push({ sql: dialect.setTimeZone(zone), origin: 'time-zone' });
  }
  for (const statement of splitStatements(config.options?.initSql ?? '', config.driver)) {
    if (config.readOnly === true && !isReadOnlyStatement(statement.text, syntaxOf(config.driver))) {
      throw new DbError(
        'permission-denied',
        msg('The init SQL of a read-only connection may not change anything: {0}', statement.text),
      );
    }
    statements.push({ sql: statement.text, origin: 'init' });
  }
  return statements;
}

/** Runs the setup on a fresh session; an error says which statement failed and why. */
export async function setUpSession(
  session: Session,
  config: ConnectionInput,
  dialect: Dialect,
): Promise<void> {
  for (const statement of setupStatements(config, dialect)) {
    try {
      for await (const _event of session.execute(statement.sql)) {
        // Settings return nothing worth keeping.
      }
    } catch (error) {
      const cause = toDbError(error);
      throw new DbError(
        cause.code,
        statement.origin === 'time-zone'
          ? msg(
              'The server refused the time zone "{0}": {1}',
              config.options?.timeZone ?? '',
              errorMessage(cause),
            )
          : msg('Init SQL failed at "{0}": {1}', statement.sql, errorMessage(cause)),
      );
    }
  }
}

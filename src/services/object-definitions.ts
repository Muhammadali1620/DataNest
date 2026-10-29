// An object's definition as the text of a SQL document: the statements the driver
// read, ready to run again in the same editor (ARCHITECTURE.md §6).

import { splitStatements } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import type { ObjectRef } from '../core/model/objects';
import type { DriverId } from '../shared/connection';
import type { ConnectionManager } from './connection-manager';
import { browseSession } from './browse-session';

/** Used around MySQL bodies; inside strings and comments it is not a terminator. */
const BODY_DELIMITER = '//';

/**
 * Joins statements into a script. A MySQL routine or trigger has semicolons in its
 * body, so the script switches the delimiter around it, as the mysql client does;
 * SQL Server ends every statement with GO; the others understand bodies without help.
 */
export function definitionDocument(statements: readonly string[], driver: DriverId): string {
  const trimmed = statements.map((statement) => statement.trim()).filter((s) => s !== '');
  if (trimmed.length === 0) {
    return '';
  }
  if (syntaxOf(driver).batchSeparator) {
    // A routine or view must be alone in its batch, which GO ends (SQL Server).
    return `${trimmed.map((statement) => `${statement}\nGO`).join('\n\n')}\n`;
  }
  const needsDelimiter =
    driver === 'mysql' &&
    trimmed.some((statement) => splitStatements(statement, driver).length > 1);
  if (needsDelimiter) {
    return `${[
      `DELIMITER ${BODY_DELIMITER}`,
      ...trimmed.map((statement) => `${statement}${BODY_DELIMITER}`),
      'DELIMITER ;',
    ].join('\n\n')}\n`;
  }
  return `${trimmed.map((statement) => `${statement};`).join('\n\n')}\n`;
}

/** Reads an object's definition on the browsing session and renders it as a script. */
export async function readDefinitionDocument(
  manager: Pick<ConnectionManager, 'acquire' | 'driverOf'>,
  connectionId: string,
  object: ObjectRef,
): Promise<string> {
  const driver = await manager.driverOf(connectionId);
  const session = await browseSession(manager, connectionId, object.database);
  return definitionDocument(await session.metadata.getDefinition(object), driver.id);
}

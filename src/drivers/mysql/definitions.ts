// Definitions come from the server's own SHOW CREATE statements, which already
// print exactly what recreates the object (indexes and keys included).

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import { quoteIdentifier } from './dialect';

/** Runs one metadata statement and returns its rows as arrays. */
export type MysqlRowReader = (sql: string, params?: unknown[]) => Promise<unknown[][]>;

/** Statement and the column holding the definition, per object kind. */
const SHOW_CREATE: Readonly<Record<ObjectRef['kind'], { keyword: string; column: number }>> = {
  table: { keyword: 'TABLE', column: 1 },
  view: { keyword: 'VIEW', column: 1 },
  procedure: { keyword: 'PROCEDURE', column: 2 },
  function: { keyword: 'FUNCTION', column: 2 },
  trigger: { keyword: 'TRIGGER', column: 2 },
  event: { keyword: 'EVENT', column: 3 },
  sequence: { keyword: 'SEQUENCE', column: 1 },
};

export async function readMysqlDefinition(
  read: MysqlRowReader,
  object: ObjectRef,
): Promise<string[]> {
  const { keyword, column } = SHOW_CREATE[object.kind];
  const name =
    object.database === undefined
      ? quoteIdentifier(object.name)
      : `${quoteIdentifier(object.database)}.${quoteIdentifier(object.name)}`;
  const rows = await read(`SHOW CREATE ${keyword} ${name}`);
  if (rows.length === 0) {
    throw new DbError('not-found', `${object.name} does not exist`);
  }
  const value = rows[0]?.[column];
  // The server returns NULL instead of the text when the user may run the routine
  // but not read it (no SHOW_ROUTINE privilege and not its definer).
  if (typeof value !== 'string' || value === '') {
    throw new DbError(
      'permission-denied',
      `The server does not show the definition of ${object.name} to this user`,
    );
  }
  return [value];
}

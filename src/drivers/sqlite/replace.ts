// Replacing a view or trigger in SQLite: there is no OR REPLACE, but DDL is
// transactional, so the old one is dropped and the new one created in one go.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import type { ReplacePlan } from '../driver';
import { quoteTable } from './quote';
import { msg } from '../../core/user-message';

export function sqliteReplaceObject(object: ObjectRef, statements: readonly string[]): ReplacePlan {
  if (object.kind !== 'view' && object.kind !== 'trigger') {
    throw new DbError('unsupported', msg('A {0} is not edited as a definition', object.kind));
  }
  return {
    check: [],
    statements: [
      'BEGIN',
      `DROP ${object.kind.toUpperCase()} IF EXISTS ${quoteTable(object)}`,
      ...statements,
      'COMMIT',
    ],
    recovery: ['ROLLBACK'],
  };
}

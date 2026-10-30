// Replacing a view, routine or trigger in PostgreSQL: DDL is transactional, so the
// whole replacement either happens or is rolled back.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import type { ReplacePlan } from '../driver';
import { quoteIdentifier, quoteTable } from './quote';
import { msg } from '../../core/user-message';

export function postgresReplaceObject(
  object: ObjectRef,
  statements: readonly string[],
): ReplacePlan {
  const schema = object.schema === undefined ? {} : { schema: object.schema };
  const drops: string[] = [];
  switch (object.kind) {
    case 'function':
    case 'procedure':
      // The definition says CREATE OR REPLACE: dropping would break what depends on it.
      break;
    case 'view':
      if (object.materialized === true) {
        // A materialized view has no OR REPLACE; its indexes come back with the script.
        drops.push(
          `DROP MATERIALIZED VIEW IF EXISTS ${quoteTable({ ...schema, name: object.name })}`,
        );
      }
      break;
    case 'trigger':
      if (object.table === undefined) {
        throw new DbError('unsupported', msg('The table of trigger {0} is unknown', object.name));
      }
      drops.push(
        `DROP TRIGGER IF EXISTS ${quoteIdentifier(object.name)} ON ${quoteTable({ ...schema, name: object.table })}`,
      );
      break;
    case 'table':
    case 'sequence':
    case 'event':
      throw new DbError('unsupported', msg('A {0} is not edited as a definition', object.kind));
  }
  return {
    check: [],
    statements: ['BEGIN', ...drops, ...statements, 'COMMIT'],
    recovery: ['ROLLBACK'],
  };
}

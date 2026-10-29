// Replacing a view, routine or trigger in SQL Server: DDL is transactional here, so
// the old object is dropped and the edited one created in one transaction, and a
// failure brings the old one back by rolling back.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import type { ReplacePlan } from '../driver';
import { quoteTable } from './quote';

export function mssqlReplaceObject(object: ObjectRef, statements: readonly string[]): ReplacePlan {
  switch (object.kind) {
    case 'view':
    case 'function':
    case 'procedure':
    case 'trigger':
      break;
    case 'table':
    case 'sequence':
    case 'event':
      throw new DbError('unsupported', `A ${object.kind} is not edited as a definition`);
  }
  // The edited text may say CREATE OR ALTER, which needs no drop; a plain CREATE does.
  const alters = statements.some((sql) => /^\s*CREATE\s+OR\s+ALTER\b/iu.test(sql));
  const drop = `DROP ${object.kind.toUpperCase()} IF EXISTS ${quoteTable(object)}`;
  return {
    check: [],
    statements: [
      'BEGIN TRANSACTION',
      ...(alters ? [] : [drop]),
      ...statements,
      'COMMIT TRANSACTION',
    ],
    recovery: ['IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'],
  };
}

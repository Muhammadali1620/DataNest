// What a SQLite dump script looks like (V5.2): one transaction, because a file
// database commits each statement to disk otherwise, and foreign keys off while it loads.

import { DbError } from '../../core/errors';
import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { DumpDialect } from '../driver';
import { quoteTable } from './quote';
import { msg } from '../../core/user-message';

export const sqliteDump: DumpDialect = {
  prepare: [],
  beginSnapshot: ['BEGIN'],
  endSnapshot: ['ROLLBACK'],
  // PRAGMA foreign_keys does nothing inside a transaction, so it comes first.
  header: ['PRAGMA foreign_keys = OFF', 'BEGIN'],
  footer: ['COMMIT', 'PRAGMA foreign_keys = ON'],
  keysAfterData: false,
  routinesFirst: false,
  insert: (quotedTable, quotedColumns, rows) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES\n${rows.join(',\n')}`,
  dropRelations: (tables: readonly TableRef[], kind: RelationKind) =>
    tables.map(
      (table) => `DROP ${kind === 'table' ? 'TABLE' : 'VIEW'} IF EXISTS ${quoteTable(table)}`,
    ),
  dropObject: (object: ObjectRef) => {
    switch (object.kind) {
      case 'table':
      case 'view':
      case 'trigger':
        return `DROP ${object.kind.toUpperCase()} IF EXISTS ${quoteTable(object)}`;
      case 'function':
      case 'procedure':
      case 'sequence':
      case 'event':
        throw new DbError('unsupported', msg('SQLite has no {0}s', object.kind));
    }
  },
};

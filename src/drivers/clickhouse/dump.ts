// What a ClickHouse dump script looks like (V5.2): there are no foreign keys, routines
// or transactions to arrange around, and no snapshot to read in; each relation is one
// CREATE as the server prints it, and rows are plain INSERT … VALUES.

import { DbError } from '../../core/errors';
import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { DumpDialect } from '../driver';
import { quoteTable } from './quote';
import { msg } from '../../core/user-message';

export const clickhouseDump: DumpDialect = {
  prepare: [],
  beginSnapshot: [],
  endSnapshot: [],
  header: [],
  footer: [],
  keysAfterData: false,
  routinesFirst: false,
  insert: (quotedTable, quotedColumns, rows) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES\n${rows.join(',\n')}`,
  insertSelect: (quotedTable, quotedColumns, select) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')})\n${select}`,
  dropRelations: (tables: readonly TableRef[], kind: RelationKind) =>
    tables.map(
      (table) => `DROP ${kind === 'table' ? 'TABLE' : 'VIEW'} IF EXISTS ${quoteTable(table)}`,
    ),
  dropObject: (object: ObjectRef) => {
    switch (object.kind) {
      case 'table':
        return `DROP TABLE IF EXISTS ${quoteTable(object)}`;
      case 'view':
        return `DROP VIEW IF EXISTS ${quoteTable(object)}`;
      case 'function':
      case 'procedure':
      case 'trigger':
      case 'sequence':
      case 'event':
        throw new DbError(
          'unsupported',
          msg('ClickHouse has no {0} inside a database', object.kind),
        );
    }
  },
};

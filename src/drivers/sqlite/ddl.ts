// Structure changes in SQLite: a file is the database, so there are no databases or
// schemas to create, no TRUNCATE, and a view cannot be renamed in place.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import type { SchemaDdl } from '../driver';
import { sqliteAlterTable } from './alter';
import { sqliteCreateTable } from './create-table';
import { sqliteReplaceObject } from './replace';
import { quoteIdentifier, quoteTable } from './quote';

const TYPES = ['integer', 'real', 'text', 'blob', 'numeric'];

export const sqliteDdl: SchemaDdl = {
  designer: { columnComments: false, tableComment: false, types: TYPES, reorder: true },
  alterTable: (table, before, after, background) =>
    sqliteAlterTable(table, before, after, background),
  createTable: sqliteCreateTable,

  dropRelation: (table, kind) => `DROP ${kind === 'table' ? 'TABLE' : 'VIEW'} ${quoteTable(table)}`,
  renameRelation: (table, kind, newName) => {
    if (kind !== 'table') {
      throw new DbError(
        'unsupported',
        'SQLite cannot rename a view: drop it and create it again under the new name',
      );
    }
    return `ALTER TABLE ${quoteTable(table)} RENAME TO ${quoteIdentifier(newName)}`;
  },
  truncateTable: (table) => `DELETE FROM ${quoteTable(table)}`,
  dropObject: (object: ObjectRef) => {
    switch (object.kind) {
      case 'table':
      case 'view':
      case 'trigger':
        return `DROP ${object.kind.toUpperCase()} ${quoteTable(object)}`;
      case 'function':
      case 'procedure':
      case 'sequence':
      case 'event':
        throw new DbError('unsupported', `SQLite has no ${object.kind}s`);
    }
  },
  replaceObject: (object, statements) => sqliteReplaceObject(object, statements),
};

// Structure changes in SQLite: a file is the database, so there are no databases or
// schemas to create, no TRUNCATE, and a view cannot be renamed in place.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import type { SchemaDdl } from '../driver';
import {
  columnSql,
  createIndexSql,
  createTableSql,
  foreignKeySql,
  primaryKeySql,
} from '../common/design-sql';
import { quoteIdentifier, quoteTable } from './quote';

const TYPES = ['integer', 'real', 'text', 'blob', 'numeric'];

export const sqliteDdl: SchemaDdl = {
  designer: { columnComments: false, tableComment: false, types: TYPES },
  createTable: (table, design) => {
    // AUTOINCREMENT exists only as part of an inline INTEGER PRIMARY KEY.
    const inlineKey = design.columns.some((column) => column.autoIncrement);
    const columns = design.columns.map((column) =>
      columnSql(column, {
        quote: quoteIdentifier,
        autoIncrement: () => 'PRIMARY KEY AUTOINCREMENT',
        trailer: () => '',
      }),
    );
    const target = quoteTable({ ...table, name: design.name.trim() });
    // A foreign key in SQLite can only point into the same database file.
    const keys = design.foreignKeys.map((key) =>
      foreignKeySql(design, key, quoteIdentifier, quoteIdentifier(key.targetTable.trim())),
    );
    return [
      createTableSql(target, [
        ...columns,
        ...(inlineKey ? [] : primaryKeySql(design, quoteIdentifier)),
        ...keys,
      ]),
      // An attached database names the index, not the table: "aux"."ix" ON "t".
      ...design.indexes.map((index) =>
        createIndexSql(
          design,
          index,
          quoteIdentifier,
          quoteIdentifier(design.name.trim()),
          quoteTable({ ...table, name: index.name.trim() }),
        ),
      ),
    ];
  },
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
};

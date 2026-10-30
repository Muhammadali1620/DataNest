// Structure changes in SQL Server. Renames go through sp_rename, which takes the new
// name bare; descriptions are extended properties, written after the table exists.

import { DbError } from '../../core/errors';
import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { SchemaDdl } from '../driver';
import { createIndexSql, createTableSql, foreignKeySql, primaryKeySql } from '../common/design-sql';
import { mssqlAlterTable } from './alter';
import { schemaOf } from './catalog';
import { describeSql } from './definitions';
import { mssqlColumnSql, renameTarget, withoutRestrict } from './design';
import { mssqlReplaceObject } from './replace';
import { quoteIdentifier, quoteString, quoteTable } from './quote';
import { msg } from '../../core/user-message';

const TYPES = [
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'bit',
  'decimal',
  'numeric',
  'money',
  'float',
  'real',
  'nvarchar',
  'varchar',
  'nchar',
  'char',
  'date',
  'time',
  'datetime2',
  'datetimeoffset',
  'datetime',
  'uniqueidentifier',
  'varbinary',
  'binary',
  'xml',
];

const RELATION_WORDS: Readonly<Record<RelationKind, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  'materialized-view': 'VIEW',
};

/** `[schema].[table]` of the designed table; `dbo` when the scope has no schema. */
function designTable(table: TableRef, name: string): { schema: string; name: string } {
  return { schema: schemaOf(table), name };
}

export const mssqlDdl: SchemaDdl = {
  createDatabase: (name) => `CREATE DATABASE ${quoteIdentifier(name)}`,
  dropDatabase: (name) => `DROP DATABASE ${quoteIdentifier(name)}`,
  createSchema: (name) => `CREATE SCHEMA ${quoteIdentifier(name)}`,
  // SQL Server has no CASCADE: a schema must be empty to be dropped.
  dropSchema: (name, cascade) => {
    if (cascade) {
      throw new DbError('unsupported', msg('SQL Server drops only empty schemas'));
    }
    return `DROP SCHEMA ${quoteIdentifier(name)}`;
  },
  // Columns of an existing table keep their places: SQL Server cannot move them.
  designer: {
    columnComments: true,
    tableComment: true,
    types: TYPES,
    reorder: false,
    autoIncrement: true,
    foreignKeys: true,
    uniqueIndexes: true,
  },
  alterTable: mssqlAlterTable,
  createTable: (table, rawDesign) => {
    const design = { ...rawDesign, foreignKeys: rawDesign.foreignKeys.map(withoutRestrict) };
    const ref = designTable(table, design.name.trim());
    const target = quoteTable(ref);
    const columns = design.columns.map(mssqlColumnSql);
    const keys = design.foreignKeys.map((key) =>
      foreignKeySql(
        design,
        key,
        quoteIdentifier,
        quoteTable({ schema: key.targetSchema ?? ref.schema, name: key.targetTable.trim() }),
      ),
    );
    const indexes = design.indexes.map((index) =>
      createIndexSql(design, index, quoteIdentifier, target),
    );
    const comments = [
      ...(design.comment === '' ? [] : [describeSql(ref, undefined, design.comment)]),
      ...design.columns
        .filter((column) => column.comment !== '')
        .map((column) => describeSql(ref, column.name.trim(), column.comment)),
    ];
    return [
      createTableSql(target, [...columns, ...primaryKeySql(design, quoteIdentifier), ...keys]),
      ...indexes,
      ...comments,
    ];
  },
  dropRelation: (table, kind) => `DROP ${RELATION_WORDS[kind]} ${quoteTable(table)}`,
  renameRelation: (table, _kind, newName) =>
    `EXEC sp_rename ${renameTarget([schemaOf(table), table.name])}, ${quoteString(newName)}`,
  truncateTable: (table) => `TRUNCATE TABLE ${quoteTable(table)}`,
  dropObject: (object: ObjectRef) => {
    switch (object.kind) {
      case 'table':
      case 'view':
        return `DROP ${RELATION_WORDS[object.kind]} ${quoteTable(object)}`;
      case 'function':
      case 'procedure':
      case 'trigger':
      case 'sequence':
        // A trigger is named by its schema, like any other object of it.
        return `DROP ${object.kind.toUpperCase()} ${quoteTable(object)}`;
      case 'event':
        throw new DbError(
          'unsupported',
          msg('SQL Server keeps scheduled jobs outside the database'),
        );
    }
  },
  replaceObject: (object, statements) => mssqlReplaceObject(object, statements),
};

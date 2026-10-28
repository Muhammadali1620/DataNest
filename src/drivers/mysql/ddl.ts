// Structure changes in MySQL and MariaDB. Views are renamed with RENAME TABLE too.

import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { SchemaDdl } from '../driver';
import {
  columnList,
  columnSql,
  createTableSql,
  foreignKeySql,
  primaryKeySql,
} from '../common/design-sql';
import { mysqlAlterTable } from './alter';
import { quoteIdentifier, quoteString, quoteTable } from './quote';

const TYPES = [
  'int',
  'int unsigned',
  'bigint',
  'bigint unsigned',
  'smallint',
  'tinyint',
  'decimal',
  'float',
  'double',
  'boolean',
  'bit',
  'char',
  'varchar',
  'text',
  'mediumtext',
  'longtext',
  'json',
  'date',
  'time',
  'datetime',
  'timestamp',
  'year',
  'binary',
  'varbinary',
  'blob',
  'longblob',
  'enum',
  'set',
];

function qualified(object: { database?: string; name: string }): string {
  return quoteTable(
    object.database === undefined
      ? { name: object.name }
      : { database: object.database, name: object.name },
  );
}

export const mysqlDdl: SchemaDdl = {
  createDatabase: (name) => `CREATE DATABASE ${quoteIdentifier(name)}`,
  dropDatabase: (name) => `DROP DATABASE ${quoteIdentifier(name)}`,
  designer: { columnComments: true, tableComment: true, types: TYPES, reorder: true },
  alterTable: mysqlAlterTable,
  createTable: (table, design) => {
    const columns = design.columns.map((column) =>
      columnSql(column, {
        quote: quoteIdentifier,
        autoIncrement: () => 'AUTO_INCREMENT',
        trailer: (c) => (c.comment === '' ? '' : `COMMENT ${quoteString(c.comment)}`),
      }),
    );
    // MySQL keeps indexes and keys inside CREATE TABLE.
    const indexes = design.indexes.map(
      (index) =>
        `${index.unique ? 'UNIQUE KEY' : 'KEY'} ${quoteIdentifier(index.name.trim())} ${columnList(design, index.columns, quoteIdentifier)}`,
    );
    const keys = design.foreignKeys.map((key) =>
      foreignKeySql(
        design,
        key,
        quoteIdentifier,
        quoteTable({
          ...table,
          ...(key.targetSchema === undefined ? {} : { database: key.targetSchema }),
          name: key.targetTable.trim(),
        }),
      ),
    );
    const comment = design.comment === '' ? '' : ` COMMENT = ${quoteString(design.comment)}`;
    return [
      createTableSql(
        quoteTable({ ...table, name: design.name.trim() }),
        [...columns, ...primaryKeySql(design, quoteIdentifier), ...indexes, ...keys],
        comment,
      ),
    ];
  },
  dropRelation: (table: TableRef, kind: RelationKind) =>
    `DROP ${kind === 'table' ? 'TABLE' : 'VIEW'} ${quoteTable(table)}`,
  renameRelation: (table, _kind, newName) =>
    `RENAME TABLE ${quoteTable(table)} TO ${quoteTable({ ...table, name: newName })}`,
  truncateTable: (table) => `TRUNCATE TABLE ${quoteTable(table)}`,
  dropObject: (object: ObjectRef) => {
    switch (object.kind) {
      case 'table':
      case 'view':
        return `DROP ${object.kind === 'table' ? 'TABLE' : 'VIEW'} ${qualified(object)}`;
      case 'function':
      case 'procedure':
      case 'trigger':
      case 'event':
      case 'sequence':
        return `DROP ${object.kind.toUpperCase()} ${qualified(object)}`;
    }
  },
};

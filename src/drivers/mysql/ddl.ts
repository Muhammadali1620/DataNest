// Structure changes in MySQL and MariaDB. Views are renamed with RENAME TABLE too.

import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { SchemaDdl } from '../driver';
import { quoteIdentifier, quoteTable } from './quote';

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
  createTableStub: (table) =>
    `CREATE TABLE ${quoteTable(table)} (\n  ${quoteIdentifier('id')} INT NOT NULL AUTO_INCREMENT PRIMARY KEY\n)`,
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

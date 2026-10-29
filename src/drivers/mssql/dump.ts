// What a SQL Server dump script looks like (V5.2). Foreign keys cannot be switched off
// for a load, so they are added after the rows (keysAfterData); values for identity
// columns need IDENTITY_INSERT, which only one table of a session may have on.

import { DbError } from '../../core/errors';
import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { DumpDialect } from '../driver';
import { quoteIdentifier, quoteString, quoteTable } from './quote';

const OBJECT_WORDS: Readonly<Record<ObjectRef['kind'], string | undefined>> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  trigger: 'TRIGGER',
  sequence: 'SEQUENCE',
  event: undefined,
};

/**
 * Drops the foreign keys of other tables that point at these, so the tables can go in
 * any order: SQL Server refuses to drop a table something still references.
 */
export function dropReferencingKeys(tables: readonly TableRef[]): string {
  const ids = tables.map((table) => `OBJECT_ID(${quoteString(quoteTable(table))})`).join(', ');
  return [
    "DECLARE @drop_keys nvarchar(max) = N''",
    "SELECT @drop_keys += N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name) + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';'",
    'FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id',
    `WHERE fk.referenced_object_id IN (${ids})`,
    'EXEC sys.sp_executesql @drop_keys',
  ].join('\n');
}

export const mssqlDump: DumpDialect = {
  prepare: [],
  // A true snapshot where the database allows one; otherwise each table is read as
  // committed at its own moment. REPEATABLE READ would lock every row read until the
  // end of the dump and stop writers on a live server.
  beginSnapshot: [
    'IF (SELECT snapshot_isolation_state FROM sys.databases WHERE database_id = DB_ID()) = 1 SET TRANSACTION ISOLATION LEVEL SNAPSHOT',
    'BEGIN TRANSACTION',
  ],
  endSnapshot: ['COMMIT', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'],
  header: ['SET NOCOUNT ON', 'SET ANSI_NULLS ON', 'SET QUOTED_IDENTIFIER ON'],
  footer: ['SET NOCOUNT OFF'],
  keysAfterData: true,
  routinesFirst: false,
  insert: (quotedTable, quotedColumns, rows, identity) => {
    const insert = `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES\n${rows.join(',\n')}`;
    return identity
      ? `SET IDENTITY_INSERT ${quotedTable} ON;\n${insert};\nSET IDENTITY_INSERT ${quotedTable} OFF`
      : insert;
  },
  // An identity takes the highest value inserted by itself, so there is nothing to reset.
  dropRelations: (tables: readonly TableRef[], kind: RelationKind) => {
    if (tables.length === 0) {
      return [];
    }
    const names = tables.map((table) => quoteTable(table)).join(', ');
    return kind === 'table'
      ? [dropReferencingKeys(tables), `DROP TABLE IF EXISTS ${names}`]
      : [`DROP VIEW IF EXISTS ${names}`];
  },
  dropObject: (object: ObjectRef) => {
    const word = OBJECT_WORDS[object.kind];
    if (word === undefined) {
      throw new DbError('unsupported', 'SQL Server keeps scheduled jobs outside the database');
    }
    return `DROP ${word} IF EXISTS ${quoteTable(object)}`;
  },
  createSchema: (name) =>
    `IF SCHEMA_ID(${quoteString(name)}) IS NULL EXEC (${quoteString(`CREATE SCHEMA ${quoteIdentifier(name)}`)})`,
};

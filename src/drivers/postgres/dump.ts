// What a PostgreSQL dump script looks like (V5.2). It is read and written with an
// empty search_path, so every name the server prints is qualified and the script
// lands in the same schemas whatever the restoring session's path is.

import { DbError } from '../../core/errors';
import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { DumpDialect } from '../driver';
import { quoteIdentifier, quoteString, quoteTable } from './quote';

const EMPTY_PATH = "SELECT pg_catalog.set_config('search_path', '', false)";

const RELATION_WORDS: Readonly<Record<RelationKind, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  'materialized-view': 'MATERIALIZED VIEW',
};

export const postgresDump: DumpDialect = {
  prepare: [EMPTY_PATH],
  beginSnapshot: ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],
  endSnapshot: ['ROLLBACK'],
  header: [
    "SET client_encoding = 'UTF8'",
    'SET standard_conforming_strings = on',
    // Function bodies may use tables that come later in the script.
    'SET check_function_bodies = false',
    'SET client_min_messages = warning',
    EMPTY_PATH,
  ],
  footer: ['RESET search_path', 'RESET check_function_bodies', 'RESET client_min_messages'],
  routinesFirst: true,
  createSchema: (name) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(name)}`,
  insert: (quotedTable, quotedColumns, rows, identity) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')})${
      identity ? ' OVERRIDING SYSTEM VALUE' : ''
    } VALUES\n${rows.join(',\n')}`,
  // Moves the sequence only when there are rows; an empty table keeps its START.
  resetSequence: (table: TableRef, column: string) => {
    const name = quoteIdentifier(column);
    return `SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence(${quoteString(
      quoteTable(table),
    )}, ${quoteString(column)}), MAX(${name})) FROM ${quoteTable(table)} HAVING MAX(${name}) IS NOT NULL`;
  },
  // One statement for all of them, so their dependencies on each other do not matter.
  dropRelations: (tables: readonly TableRef[], kind: RelationKind) =>
    tables.length === 0
      ? []
      : [
          `DROP ${RELATION_WORDS[kind]} IF EXISTS ${tables.map((table) => quoteTable(table)).join(', ')}`,
        ],
  dropObject: (object: ObjectRef) => {
    switch (object.kind) {
      case 'table':
      case 'view':
        return `DROP ${RELATION_WORDS[object.materialized === true ? 'materialized-view' : object.kind]} IF EXISTS ${quoteTable(object)}`;
      case 'function':
      case 'procedure':
        return `DROP ${object.kind.toUpperCase()} IF EXISTS ${quoteTable(object)}(${object.signature ?? ''})`;
      case 'sequence':
        return `DROP SEQUENCE IF EXISTS ${quoteTable(object)}`;
      case 'trigger':
        if (object.table === undefined) {
          throw new DbError('unsupported', `The table of trigger ${object.name} is unknown`);
        }
        return `DROP TRIGGER IF EXISTS ${quoteIdentifier(object.name)} ON ${quoteTable({
          ...object,
          name: object.table,
        })}`;
      case 'event':
        throw new DbError('unsupported', 'PostgreSQL has no scheduled events');
    }
  },
};

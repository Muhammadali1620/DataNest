// What DataNest asks a dialect for, in CQL (V13.22). CQL looks like SQL, but a table is its
// partition key and clustering columns: there is no OFFSET, no ALTER of a key, no foreign key,
// no transaction, no dump of ours. What cannot be done says so instead of writing wrong CQL.

import { DbError } from '../../core/errors';
import type { TableRef } from '../../core/model/objects';
import { KEYWORDS } from '../../core/sql/keywords';
import { msg } from '../../core/user-message';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect, DumpDialect, SchemaDdl } from '../driver';

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error(msg('Identifier must not be empty'));
  }
  if (name.includes('\u0000')) {
    throw new Error(msg('Identifier must not contain NUL'));
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/** A table is `keyspace.table`; the keyspace is the "database" of the tree. */
export function quoteTable(table: TableRef): string {
  const keyspace = table.database ?? table.schema;
  return keyspace === undefined
    ? quoteIdentifier(table.name)
    : `${quoteIdentifier(keyspace)}.${quoteIdentifier(table.name)}`;
}

/** A CQL string: single quotes, doubled inside. */
export function quoteString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** Renders a value as a CQL literal; used only where parameters cannot be. */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'NaN';
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? 'Infinity' : '-Infinity';
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return quoteString(value);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
        return /^-?\d+$/u.test(value.text) ? value.text : quoteString(value.text);
      case 'decimal':
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(value.text)
          ? value.text
          : quoteString(value.text);
      case 'datetime':
      case 'json':
        return quoteString(value.text);
      case 'binary':
        // The preview is the whole value only when it is short; CQL reads blobs as 0x….
        return value.preview.length === value.size * 2
          ? `0x${value.preview}`
          : quoteString(value.preview);
    }
  }
  return 'null';
}

const NUMBER_TYPES = new Set([
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'varint',
  'counter',
  'float',
  'double',
  'decimal',
]);

/**
 * What a filter compares a column with. CQL does not coerce: an int takes `7`, text takes `'7'`,
 * a uuid takes a bare uuid and a blob a bare `0x…`. A value that does not fit the type stays
 * a string, and the server says what is wrong with it.
 */
export function comparisonLiteral(value: string, dataType: string | undefined): string {
  const type = (dataType ?? '').toLowerCase();
  const text = value.trim();
  if (NUMBER_TYPES.has(type) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(text)) {
    return text;
  }
  if (type === 'boolean' && /^(true|false)$/iu.test(text)) {
    return text.toLowerCase();
  }
  if (
    (type === 'uuid' || type === 'timeuuid') &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)
  ) {
    return text;
  }
  if (type === 'blob' && /^0x[0-9a-f]*$/iu.test(text)) {
    return text;
  }
  return quoteString(value);
}

/** The marker `paginate` leaves for rows to skip; the session reads it back (session.ts). */
const SKIP_MARKER = /\/\*\s*datanest:skip=(\d+)\s*\*\/\s*$/u;

/** Splits a statement into its text and the number of rows the marker asks to skip. */
export function skipOf(sql: string): { readonly sql: string; readonly skip: number } {
  const match = SKIP_MARKER.exec(sql);
  if (match === null) {
    return { sql, skip: 0 };
  }
  return { sql: sql.slice(0, match.index).trimEnd(), skip: Number(match[1]) };
}

/**
 * CQL has `LIMIT` and no `OFFSET`: a later page asks for offset + limit rows, and a comment
 * tells the session how many of the first rows to drop. Cassandra reads them anyway; the
 * grid never receives them.
 */
export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0
    ? `${base} LIMIT ${limit}`
    : `${base} LIMIT ${limit + offset} /* datanest:skip=${offset} */`;
}

/** Throws the (already translated) reason a SQL-shaped action means nothing here. */
function unsupported(reason: string): never {
  throw new DbError('unsupported', reason);
}

const NO_DESIGNER = (): never =>
  unsupported(
    msg(
      'Cassandra has no table designer: a table is its key, so change it with CQL (CREATE TABLE, ALTER TABLE)',
    ),
  );

const NO_ROUTINES = (): never =>
  unsupported(msg('Functions and aggregates of Cassandra are changed with CQL'));

const ddl: SchemaDdl = {
  createDatabase: (name) =>
    `CREATE KEYSPACE ${quoteIdentifier(name)} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
  dropDatabase: (name) => `DROP KEYSPACE ${quoteIdentifier(name)}`,
  designer: {
    columnComments: false,
    tableComment: false,
    types: [],
    reorder: false,
    autoIncrement: false,
    foreignKeys: false,
    uniqueIndexes: false,
  },
  createTable: NO_DESIGNER,
  alterTable: NO_DESIGNER,
  dropRelation: (table, kind) =>
    `DROP ${kind === 'table' ? 'TABLE' : 'MATERIALIZED VIEW'} ${quoteTable(table)}`,
  renameRelation: () =>
    unsupported(msg('Cassandra cannot rename a table: create a new one and copy the rows')),
  truncateTable: (table) => `TRUNCATE ${quoteTable(table)}`,
  dropObject: NO_ROUTINES,
  replaceObject: NO_ROUTINES,
};

const NO_DUMP = (): never =>
  unsupported(msg('Cassandra has no SQL dump: use cqlsh COPY, nodetool snapshot or DSBulk'));

const dump: DumpDialect = {
  prepare: [],
  beginSnapshot: [],
  endSnapshot: [],
  header: [],
  footer: [],
  keysAfterData: false,
  routinesFirst: false,
  insert: NO_DUMP,
  insertSelect: NO_DUMP,
  dropRelations: () => [],
  dropObject: NO_DUMP,
};

export const cassandraDialect: Dialect = {
  keywords: KEYWORDS.cassandra,
  quoteIdentifier,
  quoteTable,
  literal,
  comparisonLiteral,
  paginate,
  // `LIKE` needs a SASI or SAI index on the column; without one the server says so.
  likeText: (quotedColumn, quotedPattern) => `${quotedColumn} LIKE ${quotedPattern}`,
  defaultKeyword: false,
  insertDefaultRow: () =>
    unsupported(msg('A Cassandra row exists only with its key: give the key columns')),
  // Statements are not grouped (a BATCH is not a transaction); these words exist only so the
  // interface is whole.
  transaction: {
    begin: 'BEGIN BATCH',
    commit: 'APPLY BATCH',
    rollback: 'APPLY BATCH',
    savepoint: () => 'SELECT release_version FROM system.local',
    rollbackToSavepoint: () => 'SELECT release_version FROM system.local',
  },
  ddl,
  dump,
};

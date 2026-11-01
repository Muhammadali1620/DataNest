// InfluxQL as the dialect of InfluxDB (V13.20): the table viewer, paging, filters and the
// copy-as and search helpers build InfluxQL (`SELECT * FROM "m" … LIMIT n OFFSET m`);
// Flux is written by hand in the editor. Points are written by line protocol and are not
// edited in place, so there is no DDL to build and no dump to write.

import { DbError } from '../../core/errors';
import { KEYWORDS } from '../../core/sql/keywords';
import { msg } from '../../core/user-message';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { TableRef } from '../../core/model/objects';
import type { Dialect, DumpDialect, SchemaDdl } from '../driver';

/** `"name"`: a backslash and a double quote inside are escaped with a backslash. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** A measurement is named alone: the bucket is the database of the session. */
export function quoteTable(table: TableRef): string {
  return quoteIdentifier(table.name);
}

function quoteString(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** A literal of InfluxQL; it has no NULL, so absence is spelled as the empty string. */
export function literal(value: CellValue): string {
  if (value === null) {
    throw new DbError('unsupported', msg('InfluxQL has no NULL to write'));
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : quoteString(String(value));
  }
  if (typeof value === 'string') {
    return quoteString(value);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(value.text)
          ? value.text
          : quoteString(value.text);
      case 'datetime':
      case 'json':
        return quoteString(value.text);
      case 'binary':
        return quoteString(value.preview);
    }
  }
  return quoteString('');
}

export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0 ? `${base} LIMIT ${limit}` : `${base} LIMIT ${limit} OFFSET ${offset}`;
}

function nothing(what: string): never {
  throw new DbError(
    'unsupported',
    msg('InfluxDB has no {0}: points are written, not designed', what),
  );
}

const influxDdl: SchemaDdl = {
  designer: {
    columnComments: false,
    tableComment: false,
    types: [],
    reorder: false,
    autoIncrement: false,
    foreignKeys: false,
    uniqueIndexes: false,
  },
  createTable: () => nothing('table designer'),
  alterTable: () => nothing('table designer'),
  dropRelation: (table) => `DROP MEASUREMENT ${quoteTable(table)}`,
  renameRelation: () => nothing('rename of a measurement'),
  truncateTable: () => nothing('truncate of a measurement'),
  dropObject: () => nothing('routines or triggers'),
  replaceObject: () => nothing('definitions to edit'),
};

const influxDump: DumpDialect = {
  prepare: [],
  beginSnapshot: [],
  endSnapshot: [],
  header: [],
  footer: [],
  keysAfterData: false,
  routinesFirst: false,
  insert: () => nothing('SQL dump'),
  insertSelect: () => nothing('SQL dump'),
  dropRelations: () => nothing('SQL dump'),
  dropObject: () => nothing('SQL dump'),
};

export const influxdbDialect: Dialect = {
  keywords: KEYWORDS.influxdb,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  // InfluxQL matches text with a regular expression, and the filter's LIKE has no counterpart.
  likeText: () => nothing('LIKE'),
  defaultKeyword: false,
  insertDefaultRow: () => nothing('rows of defaults'),
  // There are no transactions (the driver says so in its capabilities).
  transaction: {
    begin: 'SHOW DATABASES',
    commit: 'SHOW DATABASES',
    rollback: 'SHOW DATABASES',
    savepoint: () => 'SHOW DATABASES',
    rollbackToSavepoint: () => 'SHOW DATABASES',
  },
  ddl: influxDdl,
  dump: influxDump,
};

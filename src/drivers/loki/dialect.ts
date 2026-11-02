// What a table view, an export and the copy-as helpers need of a dialect, for Loki (V13.25).
// They build `SELECT * FROM `label` … LIMIT n OFFSET m`, which the session turns into LogQL
// (`table-query.ts`); everything that writes or designs is refused, for a log store is only read.

import { DbError } from '../../core/errors';
import { KEYWORDS } from '../../core/sql/keywords';
import { msg } from '../../core/user-message';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { TableRef } from '../../core/model/objects';
import type { Dialect, DumpDialect, SchemaDdl } from '../driver';

/** `` `name` ``: a backtick inside is doubled. The session reads the name back out. */
export function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}

/** A label is named alone: there are no databases or schemas. */
export function quoteTable(table: TableRef): string {
  return quoteIdentifier(table.name);
}

function quoteString(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** A literal for the places that quote a value; no filter reaches the server. */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
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
  throw new DbError('unsupported', msg('Loki has no {0}: it only stores log lines to read', what));
}

const lokiDdl: SchemaDdl = {
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
  dropRelation: () => nothing('way to drop a label'),
  renameRelation: () => nothing('rename of a label'),
  truncateTable: () => nothing('truncate of a label'),
  dropObject: () => nothing('routines or triggers'),
  replaceObject: () => nothing('definitions to edit'),
};

const lokiDump: DumpDialect = {
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

export const lokiDialect: Dialect = {
  keywords: KEYWORDS.loki,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  likeText: () => nothing('LIKE: filter lines with |= and |~ in LogQL'),
  defaultKeyword: false,
  insertDefaultRow: () => nothing('rows to insert'),
  // There are no transactions (the driver says so in its capabilities).
  transaction: {
    begin: '',
    commit: '',
    rollback: '',
    savepoint: () => '',
    rollbackToSavepoint: () => '',
  },
  ddl: lokiDdl,
  dump: lokiDump,
};

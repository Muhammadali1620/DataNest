import { DbError } from '../../core/errors';
import { KEYWORDS } from '../../core/sql/keywords';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect } from '../driver';
import { oracleDdl } from './ddl';
import { oracleDump } from './dump';
import { quoteIdentifier, quoteString, quoteTable, quoteText } from './quote';
import { msg } from '../../core/user-message';

export { quoteIdentifier, quoteTable };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const MOMENT =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?$/iu;

/** `+03:00` from `Z`, `UTC`, `+03`, `+0300` or `+03:00`: the only spelling Oracle reads. */
function zoneText(zone: string): string {
  if (/^(Z|UTC)$/iu.test(zone)) {
    return '+00:00';
  }
  const digits = zone.slice(1).replace(':', '');
  return `${zone[0] ?? '+'}${digits.slice(0, 2)}:${digits.slice(2, 4).padEnd(2, '0')}`;
}

/**
 * A date or moment as a typed literal, which needs no NLS format to be read:
 * DATE '2024-02-29', TIMESTAMP '2024-02-29 10:00:00.5 +03:00' (seconds and a full zone
 * are added where the text leaves them out). Other text (an interval, a time of day)
 * stays a string the server converts itself.
 */
export function datetimeLiteral(text: string): string {
  const value = text.trim();
  if (DATE_ONLY.test(value)) {
    return `DATE ${quoteString(value)}`;
  }
  const moment = MOMENT.exec(value);
  if (moment === null) {
    return quoteString(text);
  }
  const [, date = '', minutes = '', seconds = ':00', zone] = moment;
  const zoned = zone === undefined ? '' : ` ${zoneText(zone)}`;
  return `TIMESTAMP ${quoteString(`${date} ${minutes}${seconds}${zoned}`)}`;
}

/** The most bytes a RAW literal holds (HEXTORAW of 4000 hex digits). */
export const MAX_BINARY_LITERAL = 2000;

/**
 * HEXTORAW('…'). SQL has no way to join BLOB pieces, so a longer value is refused rather
 * than written cut: a dump or copy must never hold a value that is not the whole one.
 */
export function binaryLiteral(hex: string): string {
  if (hex.length > MAX_BINARY_LITERAL * 2) {
    throw new DbError(
      'unsupported',
      msg(
        'Oracle takes a binary value of at most {0} bytes in SQL text; this one has {1}',
        MAX_BINARY_LITERAL,
        hex.length / 2,
      ),
    );
  }
  return `HEXTORAW('${hex}')`;
}

/**
 * Renders a value as an Oracle literal. Only for generated SQL the user previews;
 * user input in queries goes through bind variables instead (ARCHITECTURE.md §8).
 */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  // BOOLEAN exists only from 23ai, which also takes 1 and 0 for it; NUMBER(1) takes them anywhere.
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'BINARY_DOUBLE_NAN';
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? 'BINARY_DOUBLE_INFINITY' : '-BINARY_DOUBLE_INFINITY';
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return quoteText(value);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(value.text)
          ? value.text
          : quoteString(value.text);
      case 'datetime':
        return datetimeLiteral(value.text);
      case 'json':
        return quoteText(value.text);
      case 'binary':
        return binaryLiteral(value.preview);
    }
  }
  return 'NULL';
}

/** OFFSET … FETCH (12c and newer), which needs no ORDER BY. */
export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0
    ? `${base} FETCH FIRST ${limit} ROWS ONLY`
    : `${base} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

export const oracleDialect: Dialect = {
  keywords: KEYWORDS.oracle,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  // NUM_ROWS is what the last statistics gathering counted; NULL before the first.
  estimateRowsSql: (table) =>
    `SELECT num_rows FROM all_tables WHERE owner = ${
      table.schema === undefined
        ? "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')"
        : quoteString(table.schema)
    } AND table_name = ${quoteString(table.name)}`,
  setTimeZone: (zone) => `ALTER SESSION SET TIME_ZONE = ${quoteString(zone)}`,
  // UPPER turns numbers and dates into text by the session's formats (ISO, see the
  // session) and keeps a CLOB a CLOB; TO_CHAR would fail on one over 4000 characters.
  likeText: (quotedColumn, quotedPattern) =>
    `UPPER(${quotedColumn}) LIKE UPPER(${quotedPattern}) ESCAPE '!'`,
  defaultKeyword: true,
  insertDefaultRow: () => {
    throw new DbError(
      'unsupported',
      msg('Oracle needs a value for at least one column of a new row'),
    );
  },
  // A transaction starts by itself with the first change; SET TRANSACTION starts it on
  // purpose. Savepoints go away only with the transaction.
  transaction: {
    begin: 'SET TRANSACTION READ WRITE',
    commit: 'COMMIT',
    rollback: 'ROLLBACK',
    savepoint: (name) => `SAVEPOINT ${name}`,
    rollbackToSavepoint: (name) => `ROLLBACK TO SAVEPOINT ${name}`,
  },
  ddl: oracleDdl,
  dump: oracleDump,
};

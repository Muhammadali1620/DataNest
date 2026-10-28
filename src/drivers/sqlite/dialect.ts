import { KEYWORDS } from '../../core/sql/keywords';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect } from '../driver';
import { quoteIdentifier, quoteTable } from './quote';
import { sqliteDdl } from './ddl';

export { quoteIdentifier, quoteTable };

/**
 * Renders a value as a SQLite literal. Only for generated SQL the user previews;
 * user input in queries goes through driver parameters instead (ARCHITECTURE.md §8).
 */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    // Stored as integers; 1/0 works on every SQLite version.
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'string') {
    return quoteString(value);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.text)
          ? value.text
          : quoteString(value.text);
      case 'datetime':
      case 'json':
        return quoteString(value.text);
      case 'binary':
        return `x'${value.preview}'`;
    }
  }
  return 'NULL';
}

/** SQLite never interprets backslashes: doubling quotes is enough. */
function quoteString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0 ? `${base} LIMIT ${limit}` : `${base} LIMIT ${limit} OFFSET ${offset}`;
}

export const sqliteDialect: Dialect = {
  keywords: KEYWORDS.sqlite,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  likeText: (quotedColumn, quotedPattern) =>
    `CAST(${quotedColumn} AS TEXT) LIKE ${quotedPattern} ESCAPE '!'`,
  defaultKeyword: false,
  insertDefaultRow: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES`,
  ddl: sqliteDdl,
};

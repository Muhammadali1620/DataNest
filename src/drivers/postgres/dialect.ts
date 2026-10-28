import { KEYWORDS } from '../../core/sql/keywords';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect } from '../driver';
import { quoteIdentifier, quoteString, quoteTable } from './quote';
import { postgresDdl } from './ddl';

export { quoteIdentifier, quoteTable };

/**
 * Renders a value as a PostgreSQL literal. Only for generated SQL the user previews;
 * user input in queries goes through driver parameters instead (ARCHITECTURE.md §8).
 */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
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
        return `'\\x${value.preview}'::bytea`;
    }
  }
  return 'NULL';
}

export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0 ? `${base} LIMIT ${limit}` : `${base} LIMIT ${limit} OFFSET ${offset}`;
}

export const postgresDialect: Dialect = {
  keywords: KEYWORDS.postgres,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  // reltuples is -1 until the table is first analyzed; the caller treats that as unknown.
  estimateRowsSql: (table) =>
    `SELECT reltuples::bigint FROM pg_class WHERE oid = ${literal(quoteTable(table))}::regclass`,
  likeText: (quotedColumn, quotedPattern) =>
    `CAST(${quotedColumn} AS TEXT) ILIKE ${quotedPattern} ESCAPE '!'`,
  defaultKeyword: true,
  insertDefaultRow: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES`,
  ddl: postgresDdl,
};

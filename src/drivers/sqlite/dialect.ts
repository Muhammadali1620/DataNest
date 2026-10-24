import type { TableRef } from '../../core/model/objects';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect } from '../driver';

/** Keywords offered by completion; not a full grammar, just the common surface. */
const KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'REPLACE',
  'CREATE',
  'ALTER',
  'DROP',
  'TABLE',
  'VIEW',
  'INDEX',
  'TRIGGER',
  'VIRTUAL TABLE',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
  'UNIQUE',
  'NOT NULL',
  'DEFAULT',
  'AUTOINCREMENT',
  'WITHOUT ROWID',
  'IF EXISTS',
  'IF NOT EXISTS',
  'ON CONFLICT',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'CROSS JOIN',
  'ON',
  'USING',
  'NATURAL',
  'UNION',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'DISTINCT',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'GLOB',
  'REGEXP',
  'MATCH',
  'BETWEEN',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'COALESCE',
  'IFNULL',
  'NULLIF',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_CONCAT',
  'SUBSTR',
  'TRIM',
  'LOWER',
  'UPPER',
  'LENGTH',
  'ABS',
  'ROUND',
  'DATE',
  'TIME',
  'DATETIME',
  'JULIANDAY',
  'STRFTIME',
  'JSON',
  'JSON_EXTRACT',
  'BEGIN',
  'BEGIN TRANSACTION',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
  'VACUUM',
  'ANALYZE',
  'EXPLAIN',
  'EXPLAIN QUERY PLAN',
  'ATTACH',
  'DETACH',
  'WITH',
  'RECURSIVE',
  'WINDOW',
  'OVER',
  'PARTITION BY',
  'ASC',
  'DESC',
  'BY',
  'ALL',
  'KEY',
  'CONSTRAINT',
  'CHECK',
  'RETURNING',
  'TEMP',
  'TEMPORARY',
] as const;

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error('Identifier must not be empty');
  }
  if (name.includes('\u0000')) {
    throw new Error('Identifier must not contain NUL');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteTable(table: TableRef): string {
  // SQLite scopes come from ATTACH names; the main database needs no prefix.
  const parts: string[] = [];
  if (table.database !== undefined) {
    parts.push(quoteIdentifier(table.database));
  }
  parts.push(quoteIdentifier(table.name));
  return parts.join('.');
}

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
  keywords: KEYWORDS,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
};

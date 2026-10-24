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
  'TRUNCATE',
  'RENAME',
  'TABLE',
  'VIEW',
  'INDEX',
  'DATABASE',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
  'UNIQUE',
  'NOT NULL',
  'DEFAULT',
  'AUTO_INCREMENT',
  'ENGINE',
  'IF EXISTS',
  'IF NOT EXISTS',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'CROSS JOIN',
  'ON',
  'USING',
  'UNION',
  'UNION ALL',
  'DISTINCT',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'BETWEEN',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'CONVERT',
  'COALESCE',
  'IFNULL',
  'NULLIF',
  'GREATEST',
  'LEAST',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'CONCAT',
  'SUBSTRING',
  'TRIM',
  'LOWER',
  'UPPER',
  'LENGTH',
  'NOW',
  'CURDATE',
  'CURTIME',
  'DATE_FORMAT',
  'DATE_ADD',
  'DATE_SUB',
  'BEGIN',
  'START TRANSACTION',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'SHOW',
  'DESCRIBE',
  'EXPLAIN',
  'USE',
  'GRANT',
  'REVOKE',
  'WITH',
  'RECURSIVE',
  'INTERVAL',
  'ASC',
  'DESC',
  'BY',
  'ALL',
  'ANY',
  'SOME',
  'KEY',
  'CONSTRAINT',
  'CHECK',
] as const;

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error('Identifier must not be empty');
  }
  if (name.includes('\u0000')) {
    throw new Error('Identifier must not contain NUL');
  }
  return `\`${name.replaceAll('`', '``')}\``;
}

export function quoteTable(table: TableRef): string {
  const parts: string[] = [];
  if (table.database !== undefined) {
    parts.push(quoteIdentifier(table.database));
  }
  parts.push(quoteIdentifier(table.name));
  return parts.join('.');
}

/**
 * Renders a value as a MySQL literal. Only for generated SQL the user previews;
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
        return `x'${value.preview}'`;
    }
  }
  return 'NULL';
}

/** MySQL interprets backslashes in strings by default, so both ' and \ are escaped. */
function quoteString(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0 ? `${base} LIMIT ${limit}` : `${base} LIMIT ${limit} OFFSET ${offset}`;
}

export const mysqlDialect: Dialect = {
  keywords: KEYWORDS,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
};

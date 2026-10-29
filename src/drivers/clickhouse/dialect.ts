import { KEYWORDS } from '../../core/sql/keywords';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect } from '../driver';
import { clickhouseDdl } from './ddl';
import { clickhouseDump } from './dump';
import { quoteIdentifier, quoteString, quoteTable } from './quote';
import { clickhouseText } from './values';

export { quoteIdentifier, quoteTable };

/**
 * Renders a value as a ClickHouse literal. Only for generated SQL the user previews;
 * user input in queries goes through query parameters instead (ARCHITECTURE.md §8).
 */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'nan';
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? 'inf' : '-inf';
    }
    return String(value);
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
        return quoteString(value.text);
      case 'json':
        return quoteString(jsonAsText(value.text));
      case 'binary':
        return `unhex('${value.preview}')`;
    }
  }
  return 'NULL';
}

/** JSON of an Array or Map column, as ClickHouse reads such a column from text. */
function jsonAsText(json: string): string {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null ? clickhouseText(parsed) : json;
  } catch (_error) {
    return json;
  }
}

export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0 ? `${base} LIMIT ${limit}` : `${base} LIMIT ${limit} OFFSET ${offset}`;
}

/** The text of one of our own string literals. */
function unquoted(quoted: string): string {
  const inner = /^'(.*)'$/su.exec(quoted)?.[1] ?? quoted;
  return inner.replace(/\\(.)/gsu, '$1');
}

/**
 * The filter escapes LIKE patterns with `!`; ClickHouse's LIKE escapes with a backslash
 * only and has no ESCAPE clause, so the pattern is spelled again its way.
 */
export function clickhousePattern(quotedPattern: string): string {
  const pattern = unquoted(quotedPattern);
  let result = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';
    if (char === '!' && index + 1 < pattern.length) {
      const next = pattern[index + 1] ?? '';
      result += next === '%' || next === '_' ? `\\${next}` : next === '\\' ? '\\\\' : next;
      index++;
    } else {
      result += char === '\\' ? '\\\\' : char;
    }
  }
  return quoteString(result);
}

export const clickhouseDialect: Dialect = {
  keywords: KEYWORDS.clickhouse,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  // MergeTree tables know their row count exactly; other engines report NULL.
  estimateRowsSql: (table) =>
    `SELECT total_rows FROM system.tables WHERE database = ${
      table.database === undefined ? 'currentDatabase()' : literal(table.database)
    } AND name = ${literal(table.name)}`,
  setTimeZone: (zone) => `SET session_timezone = ${literal(zone)}`,
  likeText: (quotedColumn, quotedPattern) =>
    `toString(${quotedColumn}) ILIKE ${clickhousePattern(quotedPattern)}`,
  // No `SET column = DEFAULT`; a row of defaults is an empty JSON object.
  defaultKeyword: false,
  insertDefaultRow: (quotedTable) => `INSERT INTO ${quotedTable} FORMAT JSONEachRow {}`,
  // ClickHouse has no transactions (the driver says so in its capabilities); these
  // words exist only so the interface is whole.
  transaction: {
    begin: 'BEGIN TRANSACTION',
    commit: 'COMMIT',
    rollback: 'ROLLBACK',
    savepoint: () => 'SELECT 1',
    rollbackToSavepoint: () => 'SELECT 1',
  },
  ddl: clickhouseDdl,
  dump: clickhouseDump,
};

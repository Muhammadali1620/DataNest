import { DbError } from '../../core/errors';
import { KEYWORDS } from '../../core/sql/keywords';
import { isTrivia, syntaxOf, textOf, tokenize, type Token } from '../../core/sql/tokenizer';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect } from '../driver';
import { mssqlDdl } from './ddl';
import { mssqlDump } from './dump';
import { quoteIdentifier, quoteString, quoteTable } from './quote';

export { quoteIdentifier, quoteTable };

/**
 * Renders a value as a SQL Server literal. Only for generated SQL the user previews;
 * user input in queries goes through driver parameters instead (ARCHITECTURE.md §8).
 */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DbError('unsupported', `SQL Server cannot store ${String(value)} in a number`);
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
      case 'json':
        return quoteString(value.text);
      case 'binary':
        return `0x${value.preview}`;
    }
  }
  return 'NULL';
}

interface TopLevel {
  /** Where the first SELECT's column list starts (after DISTINCT or ALL). */
  readonly listStart: number | undefined;
  readonly hasTop: boolean;
  readonly hasOrderBy: boolean;
}

/** Reads the outermost query: where its SELECT list starts, whether it has TOP or ORDER BY. */
function topLevel(sql: string): TopLevel {
  const tokens = tokenize(sql, syntaxOf('mssql')).filter((token) => !isTrivia(token));
  let depth = 0;
  let listStart: number | undefined;
  let hasTop = false;
  let hasOrderBy = false;
  const word = (token: Token | undefined): string =>
    token?.kind === 'word' ? textOf(sql, token).toUpperCase() : '';
  for (const [index, token] of tokens.entries()) {
    const text = textOf(sql, token);
    if (text === '(') {
      depth++;
    } else if (text === ')') {
      depth--;
    }
    if (depth !== 0) {
      continue;
    }
    const current = word(token);
    if (current === 'SELECT' && listStart === undefined) {
      let next = index + 1;
      if (['DISTINCT', 'ALL'].includes(word(tokens[next]))) {
        next++;
      }
      hasTop = word(tokens[next]) === 'TOP';
      listStart = tokens[next - 1]?.end;
    } else if (current === 'ORDER' && word(tokens[index + 1]) === 'BY') {
      hasOrderBy = true;
    }
  }
  return { listStart, hasTop, hasOrderBy };
}

/**
 * A page of a query. The first page takes TOP, which every query accepts; later
 * pages need OFFSET … FETCH, which needs an ORDER BY: without one the server's own
 * order is asked for (`ORDER BY (SELECT NULL)`).
 */
export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  const outer = topLevel(base);
  if (offset === 0 && outer.listStart !== undefined && !outer.hasTop && !outer.hasOrderBy) {
    return `${base.slice(0, outer.listStart)} TOP (${limit})${base.slice(outer.listStart)}`;
  }
  if (outer.listStart === undefined || outer.hasTop) {
    return `SELECT * FROM (${base}) AS [page] ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  const order = outer.hasOrderBy ? '' : ' ORDER BY (SELECT NULL)';
  return `${base}${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

export const mssqlDialect: Dialect = {
  keywords: KEYWORDS.mssql,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  // Rows of the heap or the clustered index, as the storage engine counts them.
  estimateRowsSql: (table) =>
    `SELECT SUM(rows) FROM sys.partitions WHERE object_id = OBJECT_ID(${quoteString(quoteTable(table))}) AND index_id IN (0, 1)`,
  // The column's own collation may be case-sensitive; the filter is not.
  likeText: (quotedColumn, quotedPattern) =>
    `CAST(${quotedColumn} AS NVARCHAR(MAX)) COLLATE Latin1_General_100_CI_AS LIKE ${quotedPattern} ESCAPE '!'`,
  defaultKeyword: true,
  insertDefaultRow: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES`,
  // A bare BEGIN opens a block in T-SQL; savepoints are SAVE TRANSACTION and go away
  // only with the transaction.
  transaction: {
    begin: 'BEGIN TRANSACTION',
    commit: 'COMMIT TRANSACTION',
    rollback: 'ROLLBACK TRANSACTION',
    savepoint: (name) => `SAVE TRANSACTION ${name}`,
    rollbackToSavepoint: (name) => `ROLLBACK TRANSACTION ${name}`,
  },
  ddl: mssqlDdl,
  dump: mssqlDump,
};

// Turns a table filter and a sort into SQL text. Column names are quoted by the
// dialect and values become dialect literals, so user text never lands in a
// statement unescaped. The one exception is the hand-written WHERE: it is the
// user's own SQL on the user's own connection, so it is checked only for being a
// single expression (no `;`) and otherwise passed through.

import { DbError } from '../core/errors';
import { syntaxOf, tokenize } from '../core/sql/tokenizer';
import type { Dialect } from '../drivers/driver';
import type { DriverId } from '../shared/connection';
import {
  type FilterCondition,
  type FilterOperator,
  isEmptyFilter,
  needsValue,
  type TableFilter,
} from '../shared/table-filter';
import { msg } from '../core/user-message';

const COMPARISONS: Partial<Record<FilterOperator, string>> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
};

/** Escapes LIKE wildcards in user text, using `!` (the dialects' ESCAPE character). */
export function escapeLike(text: string): string {
  return text.replace(/[!%_]/g, (char) => `!${char}`);
}

function conditionSql(dialect: Dialect, condition: FilterCondition): string {
  const column = dialect.quoteIdentifier(condition.column);
  const value = condition.value ?? '';
  const operator = condition.operator;
  if (!needsValue(operator)) {
    return `${column} ${operator === 'isNull' ? 'IS NULL' : 'IS NOT NULL'}`;
  }
  const comparison = COMPARISONS[operator];
  if (comparison !== undefined) {
    return `${column} ${comparison} ${dialect.literal(value)}`;
  }
  const escaped = escapeLike(value);
  const pattern =
    operator === 'startsWith'
      ? `${escaped}%`
      : operator === 'endsWith'
        ? `%${escaped}`
        : `%${escaped}%`;
  const like = dialect.likeText(column, dialect.literal(pattern));
  return operator === 'notContains' ? `NOT (${like})` : like;
}

/** Throws a DbError for a hand-written WHERE that is not one plain expression. */
function checkWhere(where: string, driver: DriverId): void {
  const tokens = tokenize(where, syntaxOf(driver));
  for (const token of tokens) {
    if (token.unterminated === true) {
      throw new DbError('syntax', msg('The WHERE text has an unclosed quote or comment.'));
    }
    if (token.kind === 'punctuation' && where.slice(token.start, token.end) === ';') {
      throw new DbError('syntax', msg('The WHERE text must be a single condition, without ";".'));
    }
  }
}

/**
 * The condition text after `WHERE`, or undefined when the filter is empty. The
 * hand-written part sits on its own lines inside parentheses, so a `--` comment in
 * it cannot swallow the closing one.
 */
export function buildWhere(
  dialect: Dialect,
  driver: DriverId,
  filter: TableFilter | undefined,
): string | undefined {
  if (filter === undefined || isEmptyFilter(filter)) {
    return undefined;
  }
  const parts = filter.conditions.map((condition) => conditionSql(dialect, condition));
  const where = (filter.where ?? '').trim();
  if (where !== '') {
    checkWhere(where, driver);
    parts.push(`(\n${where}\n)`);
  }
  return parts.join(' AND ');
}

export interface TableSort {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

export function buildOrderBy(dialect: Dialect, sort: TableSort | undefined): string | undefined {
  return sort === undefined
    ? undefined
    : `${dialect.quoteIdentifier(sort.column)} ${sort.direction === 'asc' ? 'ASC' : 'DESC'}`;
}

// Tables a statement defines for itself: CTEs (`WITH x AS (…)`) and subqueries in
// FROM (`FROM (SELECT …) AS x`). Their columns come from their own select list, so
// completion can offer `x.total` without asking the server.

import { tableMentions, type TableMention, unquote } from './completion-context';
import { isTrivia, textOf, type Token } from './tokenizer';

export interface DerivedTable {
  readonly name: string;
  /** Column names the select list gives, in order; `*` adds none here. */
  readonly columns: readonly string[];
  /** Tables whose columns a `*` (or `t.*`) of the select list brings in. */
  readonly starFrom: readonly TableMention[];
}

/** Words that end a select-list item's own text and cannot be an alias. */
const NOT_ALIAS = new Set([
  'FROM',
  'WHERE',
  'AS',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'END',
  'THEN',
  'ELSE',
  'DISTINCT',
  'ALL',
]);

/** A plain boolean on purpose: a type guard would wrongly narrow a punctuation token away. */
function isName(token: Token | undefined): boolean {
  return token !== undefined && (token.kind === 'word' || token.kind === 'quoted-identifier');
}

function upper(sql: string, token: Token | undefined): string {
  return token === undefined ? '' : textOf(sql, token).toUpperCase();
}

/** The index just past the parenthesis that closes the one at `open`. */
function closing(sql: string, tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    const text = upper(sql, tokens[index]);
    if (text === '(') {
      depth += 1;
    } else if (text === ')') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return tokens.length;
}

/** Splits tokens at commas that are not inside parentheses. */
function splitTopLevel(sql: string, tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    const text = textOf(sql, token);
    if (text === '(') {
      depth += 1;
    } else if (text === ')') {
      depth -= 1;
    }
    if (text === ',' && depth === 0) {
      parts.push([]);
    } else {
      parts.at(-1)?.push(token);
    }
  }
  return parts.filter((part) => part.length > 0);
}

/** Names and stars of the select list of a query given as significant tokens. */
export function selectListOf(
  sql: string,
  tokens: readonly Token[],
): { columns: string[]; star: string[] | 'all' | undefined } {
  let depth = 0;
  let start = -1;
  let end = tokens.length;
  for (const [index, token] of tokens.entries()) {
    const text = upper(sql, token);
    if (text === '(') {
      depth += 1;
    } else if (text === ')') {
      depth -= 1;
    } else if (depth === 0 && text === 'SELECT' && start === -1) {
      start = index + 1;
    } else if (depth === 0 && start !== -1 && (text === 'FROM' || text === 'UNION')) {
      end = index;
      break;
    }
  }
  if (start === -1) {
    return { columns: [], star: undefined };
  }
  while (['DISTINCT', 'ALL'].includes(upper(sql, tokens[start]))) {
    start += 1;
  }
  const columns: string[] = [];
  let star: string[] | 'all' | undefined;
  for (const item of splitTopLevel(sql, tokens.slice(start, end))) {
    const last = item.at(-1);
    const before = item.at(-2);
    if (last !== undefined && textOf(sql, last) === '*') {
      // `t.*` brings one table in, `*` all of them.
      const qualifier =
        before !== undefined && textOf(sql, before) === '.' ? item.at(-3) : undefined;
      if (qualifier === undefined) {
        star = 'all';
      } else if (star !== 'all') {
        star = [...(star ?? []), unquote(textOf(sql, qualifier))];
      }
      continue;
    }
    if (last === undefined || !isName(last) || NOT_ALIAS.has(upper(sql, last))) {
      continue;
    }
    // `expr AS name`, `expr name`, `t.name` and `name` all end with the column's name;
    // a lone expression such as `count(*)` does not, and is skipped above.
    const asAlias = upper(sql, before) === 'AS';
    const qualified = before !== undefined && textOf(sql, before) === '.';
    if (
      item.length === 1 ||
      asAlias ||
      qualified ||
      isName(before) ||
      textOf(sql, before ?? last) === ')'
    ) {
      columns.push(unquote(textOf(sql, last)));
    }
  }
  return { columns, star };
}

function derived(
  sql: string,
  name: string,
  body: readonly Token[],
  declared: readonly string[],
): DerivedTable {
  const list = selectListOf(sql, body);
  const mentions = tableMentions(sql, body);
  const starFrom =
    list.star === undefined
      ? []
      : list.star === 'all'
        ? mentions
        : mentions.filter((m) => list.star !== 'all' && list.star?.includes(m.alias ?? m.name));
  return {
    name,
    columns: declared.length > 0 ? declared : list.columns,
    starFrom: declared.length > 0 ? [] : starFrom,
  };
}

/**
 * CTEs and FROM subqueries of a statement, from its tokens (comments and spaces
 * included or not). Anything that does not parse is simply not reported.
 */
export function derivedTables(sql: string, statementTokens: readonly Token[]): DerivedTable[] {
  const tokens = statementTokens.filter((token) => !isTrivia(token));
  const found: DerivedTable[] = [];
  // WITH [RECURSIVE] name [(a, b)] AS [NOT] [MATERIALIZED] ( … ) [, …]
  let index = tokens.findIndex((token) => upper(sql, token) === 'WITH');
  if (index !== -1) {
    index += upper(sql, tokens[index + 1]) === 'RECURSIVE' ? 2 : 1;
    for (let head = tokens[index]; head !== undefined && isName(head); head = tokens[index]) {
      const name = unquote(textOf(sql, head));
      index += 1;
      const declared: string[] = [];
      if (upper(sql, tokens[index]) === '(') {
        const end = closing(sql, tokens, index);
        for (const part of splitTopLevel(sql, tokens.slice(index + 1, end - 1))) {
          const only = part[0];
          if (part.length === 1 && only !== undefined && isName(only)) {
            declared.push(unquote(textOf(sql, only)));
          }
        }
        index = end;
      }
      if (upper(sql, tokens[index]) !== 'AS') {
        break;
      }
      index += 1;
      while (['NOT', 'MATERIALIZED'].includes(upper(sql, tokens[index]))) {
        index += 1;
      }
      if (upper(sql, tokens[index]) !== '(') {
        break;
      }
      const end = closing(sql, tokens, index);
      found.push(derived(sql, name, tokens.slice(index + 1, end - 1), declared));
      index = end;
      if (upper(sql, tokens[index]) !== ',') {
        break;
      }
      index += 1;
    }
  }
  // FROM ( SELECT … ) [AS] name, and the same after JOIN or a comma.
  for (const [position, token] of tokens.entries()) {
    if (textOf(sql, token) !== '(' || upper(sql, tokens[position + 1]) !== 'SELECT') {
      continue;
    }
    const lead = upper(sql, tokens[position - 1]);
    if (lead !== 'FROM' && lead !== 'JOIN' && lead !== ',') {
      continue;
    }
    const end = closing(sql, tokens, position);
    let aliasAt = end;
    if (upper(sql, tokens[aliasAt]) === 'AS') {
      aliasAt += 1;
    }
    const alias = tokens[aliasAt];
    if (alias !== undefined && isName(alias) && !NOT_ALIAS.has(upper(sql, alias))) {
      found.push(
        derived(sql, unquote(textOf(sql, alias)), tokens.slice(position + 1, end - 1), []),
      );
    }
  }
  return found;
}

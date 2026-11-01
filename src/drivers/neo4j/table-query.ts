// Opening a label (or a relationship type) from the tree builds a few lines of SQL — the
// shape every table view, export and search uses — and Neo4j speaks Cypher. This turns
// exactly those shapes into Cypher and leaves everything else to the server:
//
//   SELECT * FROM `Person` WHERE … ORDER BY … LIMIT 100 OFFSET 200
//   SELECT `name`, `age` FROM `Person` …
//   SELECT COUNT(*) FROM `Person` WHERE …
//
// A column is a property, and `_id`, `_labels` (nodes), `_type`, `_from` and `_to`
// (relationships) are the parts of the entity itself. A relationship type is listed as
// `[KNOWS]`, which tells the two apart. The conditions are written by the filter through
// the dialect, so a name in backticks stands for a property of the node `n`; a name after
// a dot (the user's own `n.age > 3`) is left as it is.

import { isTrivia, syntaxOf, textOf, tokenize, type Token } from '../../core/sql/tokenizer';

const SYNTAX = syntaxOf('neo4j');

export type TableQueryKind = 'nodes' | 'relationships';

export interface TableQuery {
  readonly kind: TableQueryKind;
  /** The Cypher to run. */
  readonly cypher: string;
  /**
   * `count`: one cell, the number. Otherwise rows hold the entity and its properties, and
   * these are the columns asked for (`*` is every key the page holds).
   */
  readonly columns: 'count' | '*' | readonly string[];
}

/** Names of the columns that are the entity and not one of its properties. */
export const NODE_PARTS = ['_id', '_labels'] as const;
export const RELATIONSHIP_PARTS = ['_id', '_type', '_from', '_to'] as const;

const ENTITY = 'n';

/** `` `a``b` `` → `a`b`. */
function unquote(text: string): string {
  return text.slice(1, -1).replaceAll('``', '`');
}

export function quoteName(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}

/** A relationship type is listed between brackets, a label as it is. */
export function relationshipName(name: string): string | undefined {
  return /^\[.+\]$/su.test(name) ? name.slice(1, -1) : undefined;
}

/** `` `x` `` as a property of the entity, or one of its own parts. */
function propertyOf(name: string, kind: TableQueryKind): string {
  if (name === '_id') {
    return `elementId(${ENTITY})`;
  }
  if (kind === 'nodes' && name === '_labels') {
    return `labels(${ENTITY})`;
  }
  if (kind === 'relationships') {
    if (name === '_type') {
      return `type(${ENTITY})`;
    }
    if (name === '_from') {
      return `elementId(startNode(${ENTITY}))`;
    }
    if (name === '_to') {
      return `elementId(endNode(${ENTITY}))`;
    }
  }
  return `${ENTITY}.${quoteName(name)}`;
}

const NUMBER = /^-?\d+(\.\d+)?$/u;

/** Compared as text, `n.age = '30'` would never be true; a filter value is always text. */
function comparison(left: string, operator: string, literal: string): string | undefined {
  const text = /^'((?:[^'\\]|\\.)*)'$/su.exec(literal)?.[1];
  if (text === undefined || !NUMBER.test(text)) {
    return undefined;
  }
  switch (operator) {
    case '=':
      return `(toString(${left}) = ${literal})`;
    case '<>':
      return `(toString(${left}) <> ${literal})`;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return `(${left} ${operator} ${literal} OR ${left} ${operator} ${text})`;
    default:
      return undefined;
  }
}

/**
 * Rewrites the names the filter quoted into properties of `n`. A name that follows a dot
 * belongs to the user's own text and stays. A comparison with a number written as text is
 * made to hold for numbers too.
 */
function rewrite(text: string, kind: TableQueryKind): string {
  const tokens = tokenize(text, SYNTAX);
  let result = '';
  let previous: Token | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    const source = textOf(text, token);
    if (token.kind === 'quoted-identifier') {
      const afterDot = previous !== undefined && textOf(text, previous) === '.';
      const column = propertyOf(unquote(source), kind);
      const operator = nextOperator(text, tokens, index);
      if (!afterDot && operator !== undefined) {
        const replaced = comparison(column, operator.text, operator.literal);
        if (replaced !== undefined) {
          result += replaced;
          index = operator.end;
          previous = tokens[index];
          continue;
        }
      }
      result += afterDot ? source : column;
    } else {
      result += source;
    }
    if (!isTrivia(token)) {
      previous = token;
    }
  }
  return result;
}

/** The comparison operator and string literal that follow the token at `index`, if any. */
function nextOperator(
  text: string,
  tokens: readonly Token[],
  index: number,
): { text: string; literal: string; end: number } | undefined {
  const rest: Token[] = [];
  let end = index;
  for (let next = index + 1; next < tokens.length && rest.length < 4; next++) {
    const token = tokens[next];
    if (token === undefined) {
      break;
    }
    end = next;
    if (isTrivia(token)) {
      continue;
    }
    rest.push(token);
    if (token.kind === 'string') {
      break;
    }
  }
  const literal = rest.at(-1);
  if (literal?.kind !== 'string') {
    return undefined;
  }
  const operator = rest
    .slice(0, -1)
    .map((token) => textOf(text, token))
    .join('');
  return ['=', '<>', '<', '<=', '>', '>='].includes(operator)
    ? { text: operator, literal: textOf(text, literal), end }
    : undefined;
}

interface Tail {
  where?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/** Splits what follows `FROM name` at its top-level WHERE, ORDER BY, LIMIT and OFFSET. */
function splitTail(tail: string): Tail | undefined {
  const tokens = tokenize(tail, SYNTAX);
  const marks: { word: string; start: number; end: number }[] = [];
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    const text = textOf(tail, token);
    if (token.kind === 'punctuation') {
      if (text === '(' || text === '[' || text === '{') {
        depth += 1;
      } else if (text === ')' || text === ']' || text === '}') {
        depth = Math.max(0, depth - 1);
      }
    } else if (token.kind === 'word' && depth === 0) {
      const word = text.toUpperCase();
      if (word === 'WHERE' || word === 'LIMIT' || word === 'OFFSET' || word === 'SKIP') {
        marks.push({ word, start: token.start, end: token.end });
      } else if (word === 'ORDER') {
        const next = tokens.slice(index + 1).find((candidate) => !isTrivia(candidate));
        if (next !== undefined && textOf(tail, next).toUpperCase() === 'BY') {
          marks.push({ word, start: token.start, end: next.end });
        }
      }
    }
  }
  if (marks.some((mark, index) => marks.findIndex((other) => other.word === mark.word) !== index)) {
    return undefined;
  }
  if ((marks[0]?.start ?? tail.length) !== tail.search(/\S|$/u)) {
    // Something other than a clause follows the table name.
    return tail.trim() === '' ? {} : undefined;
  }
  const result: Tail = {};
  for (const [index, mark] of marks.entries()) {
    const body = tail.slice(mark.end, marks[index + 1]?.start ?? tail.length).trim();
    switch (mark.word) {
      case 'WHERE':
        result.where = body;
        break;
      case 'ORDER':
        result.orderBy = body;
        break;
      case 'LIMIT':
      case 'OFFSET':
      case 'SKIP': {
        if (!/^\d+$/u.test(body)) {
          return undefined;
        }
        if (mark.word === 'LIMIT') {
          result.limit = Number(body);
        } else {
          result.offset = Number(body);
        }
        break;
      }
    }
  }
  return result;
}

const HEAD = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+(`(?:[^`]|``)+`)([\s\S]*)$/iu;

/** The columns of a select list: `*`, `COUNT(*)`, or names in backticks; undefined otherwise. */
function selectList(list: string): 'count' | '*' | string[] | undefined {
  const text = list.trim();
  if (text === '*') {
    return '*';
  }
  if (/^COUNT\s*\(\s*\*\s*\)$/iu.test(text)) {
    return 'count';
  }
  const names: string[] = [];
  const pattern = /\s*(`(?:[^`]|``)+`)\s*(,|$)/uy;
  let position = 0;
  while (position < text.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    if (match === null) {
      return undefined;
    }
    names.push(unquote(match[1] ?? ''));
    position = pattern.lastIndex;
  }
  return names.length === 0 ? undefined : names;
}

/** The Cypher for a table-shaped SELECT, or undefined when the text is something else. */
export function translateTableQuery(sql: string): TableQuery | undefined {
  const match = HEAD.exec(sql.replace(/[\s;]+$/u, ''));
  if (match === null) {
    return undefined;
  }
  const columns = selectList(match[1] ?? '');
  const tail = splitTail(match[3] ?? '');
  if (columns === undefined || tail === undefined) {
    return undefined;
  }
  const name = unquote(match[2] ?? '');
  const type = relationshipName(name);
  const kind: TableQueryKind = type === undefined ? 'nodes' : 'relationships';
  const pattern =
    type === undefined ? `(${ENTITY}:${quoteName(name)})` : `()-[${ENTITY}:${quoteName(type)}]->()`;
  const where = tail.where === undefined ? '' : `\nWHERE ${rewrite(tail.where, kind)}`;
  if (columns === 'count') {
    return { kind, cypher: `MATCH ${pattern}${where}\nRETURN count(${ENTITY}) AS count`, columns };
  }
  const parts =
    kind === 'nodes'
      ? `elementId(${ENTITY}) AS \`_id\`, labels(${ENTITY}) AS \`_labels\``
      : `elementId(${ENTITY}) AS \`_id\`, type(${ENTITY}) AS \`_type\`, elementId(startNode(${ENTITY})) AS \`_from\`, elementId(endNode(${ENTITY})) AS \`_to\``;
  const order = tail.orderBy === undefined ? '' : `\nORDER BY ${rewrite(tail.orderBy, kind)}`;
  const skip = tail.offset === undefined || tail.offset === 0 ? '' : `\nSKIP ${tail.offset}`;
  const limit = tail.limit === undefined ? '' : `\nLIMIT ${tail.limit}`;
  return {
    kind,
    cypher: `MATCH ${pattern}${where}\nRETURN ${parts}, properties(${ENTITY}) AS \`_properties\`${order}${skip}${limit}`,
    columns,
  };
}

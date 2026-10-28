// What the user is typing, so completion can offer the right thing: a table after
// FROM, a column after SELECT or after `alias.`, a keyword anywhere else.

import type { DriverId } from '../../shared/connection';
import { statementAt } from './split';
import { isTrivia, syntaxOf, textOf, tokenize, type Token } from './tokenizer';

/** A table the statement refers to, with the alias it was given. */
export interface TableMention {
  readonly name: string;
  readonly schema?: string;
  readonly database?: string;
  readonly alias?: string;
}

export type CompletionKind =
  /** After a dot: columns of the qualifier, or tables of that database/schema. */
  | 'qualified'
  /** A table name is expected (FROM, JOIN, UPDATE, INTO). */
  | 'table'
  /** A column name is expected (SELECT, WHERE, ON, SET, …). */
  | 'column'
  /** Anything goes: keywords first, then tables. */
  | 'any';

export interface CompletionContext {
  readonly kind: CompletionKind;
  /** What the user has typed of the current word. */
  readonly prefix: string;
  /** Offset where the current word starts, for the replacement range. */
  readonly start: number;
  /** For `qualified`: the name before the dot, unquoted. */
  readonly qualifier?: string;
  /** Tables the statement mentions, so columns can be looked up. */
  readonly tables: readonly TableMention[];
  /** True when the cursor sits inside a string or a comment: offer nothing. */
  readonly inText: boolean;
}

/** Clause keywords that say a table name comes next. */
const TABLE_CLAUSES = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);

/** Clause keywords that say a column name comes next. */
const COLUMN_CLAUSES = new Set([
  'SELECT',
  'WHERE',
  'ON',
  'SET',
  'HAVING',
  'BY',
  'USING',
  'RETURNING',
]);

/** Words that are never an alias, so `FROM t WHERE` does not read as alias `WHERE`. */
const NOT_ALIASES = new Set([
  'AS',
  'ON',
  'USING',
  'WHERE',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'OUTER',
  'NATURAL',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'SET',
  'VALUES',
  'RETURNING',
  'WINDOW',
  'FETCH',
  'FOR',
  'LATERAL',
  'AND',
  'OR',
  'SELECT',
]);

/**
 * Reads the statement the cursor is in. Everything is derived from tokens, so a
 * semicolon or a keyword inside a string never confuses the result.
 */
export function completionContextAt(
  sql: string,
  offset: number,
  driver?: DriverId,
): CompletionContext {
  const syntax = syntaxOf(driver);
  // Offsets stay in the source: trimming the statement would lose the space that
  // separates the cursor from the word before it.
  const all = tokenize(sql, syntax);

  // Checked before anything else: a document of nothing but a comment has no
  // statement to look at, and typing in it must still suggest nothing.
  if (all.some((token) => isTypingInside(sql, token, offset))) {
    return { kind: 'any', prefix: '', start: offset, tables: [], inText: true };
  }

  const statement = statementAt(sql, offset, driver);
  if (statement === undefined || offset < statement.start) {
    return { kind: 'any', prefix: '', start: offset, tables: [], inText: false };
  }
  // Past the terminator of the statement, the next one begins: `SELECT 1; |`.
  if (afterTerminator(all, statement.end, offset)) {
    const word = wordAt(all, offset);
    return {
      kind: 'any',
      prefix: word === undefined ? '' : sql.slice(word.start, offset),
      start: word?.start ?? offset,
      tables: [],
      inText: false,
    };
  }
  const tokens = all.filter((token) => token.end > statement.start);

  const word = wordAt(tokens, offset);
  const prefix = word === undefined ? '' : sql.slice(word.start, offset);
  const start = word?.start ?? offset;
  const statementTokens = tokens.filter((token) => token.end <= statement.end);
  const tables = tableMentions(sql, statementTokens);

  const previous = lastSignificantBefore(tokens, word?.start ?? offset);
  if (previous && textOf(sql, previous) === '.') {
    const qualifier = qualifierBefore(sql, tokens, previous);
    return {
      kind: 'qualified',
      prefix,
      start,
      ...(qualifier === undefined ? {} : { qualifier }),
      tables,
      inText: false,
    };
  }

  const clause = lastClause(sql, tokens, word?.start ?? offset);
  const kind: CompletionKind =
    clause === undefined
      ? 'any'
      : TABLE_CLAUSES.has(clause)
        ? 'table'
        : COLUMN_CLAUSES.has(clause)
          ? 'column'
          : 'any';
  return { kind, prefix, start, tables, inText: false };
}

/**
 * True when typing at `offset` continues the text of this token. A line comment
 * or an unclosed construct swallows whatever comes next, so its very end counts
 * as inside; a closed string or block comment does not.
 */
function isTypingInside(sql: string, token: Token, offset: number): boolean {
  if (token.kind !== 'string' && token.kind !== 'comment') {
    return false;
  }
  if (token.start >= offset) {
    return false;
  }
  if (offset < token.end) {
    return true;
  }
  const text = textOf(sql, token);
  const openEnded = token.unterminated === true || text.startsWith('--') || text.startsWith('#');
  return openEnded && offset === token.end;
}

/** True when something other than spaces and comments lies between a statement and the cursor. */
export function afterTerminator(
  tokens: readonly Token[],
  statementEnd: number,
  offset: number,
): boolean {
  return tokens.some(
    (token) => token.start >= statementEnd && token.end <= offset && !isTrivia(token),
  );
}

/** The word token the cursor is in or right after. */
function wordAt(tokens: readonly Token[], offset: number): Token | undefined {
  return tokens.find(
    (token) =>
      (token.kind === 'word' || token.kind === 'quoted-identifier') &&
      token.start <= offset &&
      token.end >= offset,
  );
}

function lastSignificantBefore(tokens: readonly Token[], offset: number): Token | undefined {
  let found: Token | undefined;
  for (const token of tokens) {
    if (token.end > offset) {
      break;
    }
    if (!isTrivia(token)) {
      found = token;
    }
  }
  return found;
}

/** The name before a dot, with quotes removed. */
function qualifierBefore(text: string, tokens: readonly Token[], dot: Token): string | undefined {
  const before = lastSignificantBefore(tokens, dot.start);
  if (before === undefined || (before.kind !== 'word' && before.kind !== 'quoted-identifier')) {
    return undefined;
  }
  return unquote(textOf(text, before));
}

/** The nearest clause keyword before the cursor, uppercased. */
function lastClause(text: string, tokens: readonly Token[], offset: number): string | undefined {
  let clause: string | undefined;
  for (const token of tokens) {
    if (token.start >= offset) {
      break;
    }
    if (token.kind !== 'word') {
      continue;
    }
    const word = textOf(text, token).toUpperCase();
    if (TABLE_CLAUSES.has(word) || COLUMN_CLAUSES.has(word)) {
      clause = word;
    }
  }
  return clause;
}

/** Strips `"`, `` ` `` or `[]` quoting from a name. */
export function unquote(name: string): string {
  if (name.length >= 2) {
    const first = name[0];
    const last = name[name.length - 1];
    if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
      return name.slice(1, -1).replaceAll(`${first}${first}`, first);
    }
  }
  return name;
}

/**
 * Tables named after FROM, JOIN, UPDATE or INTO, with their aliases. Good enough
 * for completion: it reads names, not the whole grammar.
 */
export function tableMentions(text: string, tokens?: readonly Token[]): TableMention[] {
  const list = tokens ?? tokenize(text);
  const significant = list.filter((token) => !isTrivia(token));
  const mentions: TableMention[] = [];
  for (const [index, token] of significant.entries()) {
    if (token.kind !== 'word') {
      continue;
    }
    if (!TABLE_CLAUSES.has(textOf(text, token).toUpperCase())) {
      continue;
    }
    let position = index + 1;
    // A clause may list several tables: `FROM a, b AS c`.
    for (;;) {
      const parsed = readName(text, significant, position);
      if (parsed === undefined) {
        break;
      }
      mentions.push(parsed.mention);
      position = parsed.next;
      const separator = significant[position];
      if (separator && textOf(text, separator) === ',') {
        position += 1;
        continue;
      }
      break;
    }
  }
  return mentions;
}

interface ParsedName {
  readonly mention: TableMention;
  readonly next: number;
}

/** `name`, `schema.name`, `db.schema.name`, each part optionally quoted, plus an alias. */
function readName(text: string, tokens: readonly Token[], from: number): ParsedName | undefined {
  const parts: string[] = [];
  let position = from;
  for (;;) {
    const token = tokens[position];
    if (token === undefined || (token.kind !== 'word' && token.kind !== 'quoted-identifier')) {
      break;
    }
    if (parts.length === 0 && NOT_ALIASES.has(textOf(text, token).toUpperCase())) {
      // `FROM WHERE` is nonsense; treat it as no table at all.
      return undefined;
    }
    parts.push(unquote(textOf(text, token)));
    position += 1;
    const dot = tokens[position];
    if (dot && textOf(text, dot) === '.') {
      position += 1;
      continue;
    }
    break;
  }
  if (parts.length === 0) {
    return undefined;
  }
  const name = parts[parts.length - 1] ?? '';
  const mention: TableMention = {
    name,
    ...(parts.length >= 2 ? { schema: parts[parts.length - 2] } : {}),
    ...(parts.length >= 3 ? { database: parts[parts.length - 3] } : {}),
  };
  const alias = readAlias(text, tokens, position);
  return {
    mention: alias === undefined ? mention : { ...mention, alias: alias.name },
    next: alias === undefined ? position : alias.next,
  };
}

/** `AS x` or a bare `x` that is not a keyword. */
function readAlias(
  text: string,
  tokens: readonly Token[],
  from: number,
): { name: string; next: number } | undefined {
  let position = from;
  const first = tokens[position];
  if (first?.kind === 'word' && textOf(text, first).toUpperCase() === 'AS') {
    position += 1;
  }
  const token = tokens[position];
  if (token === undefined || (token.kind !== 'word' && token.kind !== 'quoted-identifier')) {
    return undefined;
  }
  const name = textOf(text, token);
  if (token.kind === 'word' && NOT_ALIASES.has(name.toUpperCase())) {
    return undefined;
  }
  return { name: unquote(name), next: position + 1 };
}

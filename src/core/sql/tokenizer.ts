// A scanner that knows just enough SQL to tell code from text: what is a string,
// a comment, a quoted name, a word. Everything that needs to find a semicolon that
// really ends a statement (splitting, CodeLens, completion context) builds on it.

import type { DriverId } from '../../shared/connection';

export type TokenKind =
  'whitespace' | 'comment' | 'string' | 'quoted-identifier' | 'word' | 'number' | 'punctuation';

export interface Token {
  readonly kind: TokenKind;
  /** Offset of the first character in the source. */
  readonly start: number;
  /** Offset just past the last character. */
  readonly end: number;
  /** Set when the source ended before the construct was closed. */
  readonly unterminated?: true;
}

/** How a dialect spells the things a scanner must not misread. */
export interface SqlSyntax {
  /** `\` escapes inside single-quoted strings (MySQL). */
  readonly backslashEscapes: boolean;
  /** `#` starts a line comment (MySQL). */
  readonly hashComments: boolean;
  /** `` ` `` quotes identifiers (MySQL). */
  readonly backtickIdentifiers: boolean;
  /** `"` quotes identifiers; where false it is a string (MySQL default). */
  readonly doubleQuoteIdentifiers: boolean;
  /** `E'…'` strings, where `\` escapes even with standard strings (PostgreSQL). */
  readonly escapeStrings: boolean;
  /** `$tag$ … $tag$` string literals (PostgreSQL). */
  readonly dollarQuotes: boolean;
  /** Block comments may nest (PostgreSQL). */
  readonly nestedBlockComments: boolean;
  /** The client `DELIMITER` command changes the statement terminator (MySQL). */
  readonly delimiterCommand: boolean;
  /**
   * `CREATE TRIGGER … BEGIN … END` holds semicolons in its body, and the server
   * expects the whole thing as one statement without a delimiter switch (SQLite).
   */
  readonly triggerBodies: boolean;
  /** Block comments opening with `/*!` are code the server runs (MySQL, MariaDB). */
  readonly executableComments: boolean;
  /** `[…]` quotes identifiers, `]]` inside (SQL Server). */
  readonly bracketIdentifiers: boolean;
  /**
   * A line holding only `GO` ends a batch (the sqlcmd convention, SQL Server). Routine
   * bodies and batches that declare variables then run as one statement up to it.
   */
  readonly batchSeparator: boolean;
}

const MYSQL: SqlSyntax = {
  backslashEscapes: true,
  hashComments: true,
  backtickIdentifiers: true,
  doubleQuoteIdentifiers: false,
  escapeStrings: false,
  dollarQuotes: false,
  nestedBlockComments: false,
  delimiterCommand: true,
  triggerBodies: false,
  executableComments: true,
  bracketIdentifiers: false,
  batchSeparator: false,
};

const POSTGRES: SqlSyntax = {
  backslashEscapes: false,
  hashComments: false,
  backtickIdentifiers: false,
  doubleQuoteIdentifiers: true,
  escapeStrings: true,
  dollarQuotes: true,
  nestedBlockComments: true,
  delimiterCommand: false,
  triggerBodies: false,
  executableComments: false,
  bracketIdentifiers: false,
  batchSeparator: false,
};

const SQLITE: SqlSyntax = {
  backslashEscapes: false,
  hashComments: false,
  backtickIdentifiers: true,
  doubleQuoteIdentifiers: true,
  escapeStrings: false,
  dollarQuotes: false,
  nestedBlockComments: false,
  delimiterCommand: false,
  triggerBodies: true,
  executableComments: false,
  bracketIdentifiers: false,
  batchSeparator: false,
};

const MSSQL: SqlSyntax = {
  backslashEscapes: false,
  hashComments: false,
  backtickIdentifiers: false,
  // QUOTED_IDENTIFIER is on in every session clients open.
  doubleQuoteIdentifiers: true,
  escapeStrings: false,
  dollarQuotes: false,
  nestedBlockComments: true,
  delimiterCommand: false,
  triggerBodies: false,
  executableComments: false,
  bracketIdentifiers: true,
  batchSeparator: true,
};

const BY_DRIVER: Readonly<Record<DriverId, SqlSyntax>> = {
  mysql: MYSQL,
  postgres: POSTGRES,
  sqlite: SQLITE,
  mssql: MSSQL,
};

/** The syntax of a driver; the safest common set when none is known. */
export function syntaxOf(driver?: DriverId): SqlSyntax {
  if (driver === undefined) {
    // Accept the union of quoting styles, so nothing is mistaken for code.
    return {
      backslashEscapes: false,
      hashComments: true,
      backtickIdentifiers: true,
      doubleQuoteIdentifiers: true,
      escapeStrings: true,
      dollarQuotes: true,
      nestedBlockComments: false,
      delimiterCommand: true,
      triggerBodies: false,
      executableComments: false,
      // `[` is an array subscript in PostgreSQL; `GO` is a word anywhere else.
      bracketIdentifiers: false,
      batchSeparator: false,
    };
  }
  return BY_DRIVER[driver];
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

/** Splits SQL into tokens. Never throws: bad input ends in an unterminated token. */
export function tokenize(sql: string, syntax: SqlSyntax = syntaxOf()): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const token = readToken(sql, index, syntax);
    tokens.push(token);
    // Every reader consumes at least one character, so this always terminates.
    index = token.end;
  }
  return tokens;
}

function readToken(sql: string, start: number, syntax: SqlSyntax): Token {
  const char = sql[start] ?? '';
  if (/\s/.test(char)) {
    return { kind: 'whitespace', start, end: runOfWhitespace(sql, start) };
  }
  if (sql.startsWith('--', start)) {
    return { kind: 'comment', start, end: endOfLine(sql, start + 2) };
  }
  if (syntax.hashComments && char === '#') {
    return { kind: 'comment', start, end: endOfLine(sql, start + 1) };
  }
  if (sql.startsWith('/*', start)) {
    return blockComment(sql, start, syntax);
  }
  if (char === "'") {
    return quoted(sql, start, "'", syntax.backslashEscapes, 'string');
  }
  if (char === '"') {
    return quoted(
      sql,
      start,
      '"',
      syntax.backslashEscapes && !syntax.doubleQuoteIdentifiers,
      syntax.doubleQuoteIdentifiers ? 'quoted-identifier' : 'string',
    );
  }
  if (char === '`' && syntax.backtickIdentifiers) {
    return quoted(sql, start, '`', false, 'quoted-identifier');
  }
  if (char === '[' && syntax.bracketIdentifiers) {
    return bracketed(sql, start);
  }
  if (char === '$' && syntax.dollarQuotes) {
    const dollar = dollarQuoted(sql, start);
    if (dollar) {
      return dollar;
    }
  }
  if (syntax.escapeStrings && (char === 'E' || char === 'e') && sql[start + 1] === "'") {
    return { ...quoted(sql, start + 1, "'", true, 'string'), start };
  }
  if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(sql[start + 1] ?? ''))) {
    return { kind: 'number', start, end: endOfNumber(sql, start) };
  }
  if (WORD_START.test(char)) {
    let end = start + 1;
    while (end < sql.length && WORD_PART.test(sql[end] ?? '')) {
      end++;
    }
    return { kind: 'word', start, end };
  }
  return { kind: 'punctuation', start, end: start + 1 };
}

function runOfWhitespace(sql: string, start: number): number {
  let end = start;
  while (end < sql.length && /\s/.test(sql[end] ?? '')) {
    end++;
  }
  return end;
}

/** A line comment ends at the newline, which belongs to the following whitespace. */
function endOfLine(sql: string, from: number): number {
  const newline = sql.indexOf('\n', from);
  return newline === -1 ? sql.length : newline;
}

function blockComment(sql: string, start: number, syntax: SqlSyntax): Token {
  let index = start + 2;
  let depth = 1;
  while (index < sql.length) {
    if (syntax.nestedBlockComments && sql.startsWith('/*', index)) {
      depth++;
      index += 2;
      continue;
    }
    if (sql.startsWith('*/', index)) {
      depth--;
      index += 2;
      if (depth === 0) {
        return { kind: 'comment', start, end: index };
      }
      continue;
    }
    index++;
  }
  return { kind: 'comment', start, end: sql.length, unterminated: true };
}

/**
 * Reads text between `quote` characters. A doubled quote stays inside the token,
 * and with `backslashEscapes` a `\` hides whatever follows it.
 */
function quoted(
  sql: string,
  start: number,
  quote: string,
  backslashEscapes: boolean,
  kind: TokenKind,
): Token {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashEscapes && char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return { kind, start, end: index + 1 };
    }
    index++;
  }
  return { kind, start, end: sql.length, unterminated: true };
}

/** `[name]`, where `]]` stands for one `]`. */
function bracketed(sql: string, start: number): Token {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === ']') {
      if (sql[index + 1] === ']') {
        index += 2;
        continue;
      }
      return { kind: 'quoted-identifier', start, end: index + 1 };
    }
    index++;
  }
  return { kind: 'quoted-identifier', start, end: sql.length, unterminated: true };
}

const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/** `$$ … $$` or `$tag$ … $tag$`; undefined when `$` is just punctuation. */
function dollarQuoted(sql: string, start: number): Token | undefined {
  const match = DOLLAR_TAG.exec(sql.slice(start));
  if (!match) {
    return undefined;
  }
  const tag = match[0];
  const closing = sql.indexOf(tag, start + tag.length);
  if (closing === -1) {
    return { kind: 'string', start, end: sql.length, unterminated: true };
  }
  return { kind: 'string', start, end: closing + tag.length };
}

function endOfNumber(sql: string, start: number): number {
  let index = start;
  while (index < sql.length && /[0-9]/.test(sql[index] ?? '')) {
    index++;
  }
  if (sql[index] === '.') {
    index++;
    while (index < sql.length && /[0-9]/.test(sql[index] ?? '')) {
      index++;
    }
  }
  if (sql[index] === 'e' || sql[index] === 'E') {
    const afterExponent = sql[index + 1] === '+' || sql[index + 1] === '-' ? index + 2 : index + 1;
    if (/[0-9]/.test(sql[afterExponent] ?? '')) {
      index = afterExponent;
      while (index < sql.length && /[0-9]/.test(sql[index] ?? '')) {
        index++;
      }
    }
  }
  return index;
}

/** True for tokens that carry no meaning for parsing, only for the reader. */
export function isTrivia(token: Token): boolean {
  return token.kind === 'whitespace' || token.kind === 'comment';
}

/** The source text of a token. */
export function textOf(sql: string, token: Token): string {
  return sql.slice(token.start, token.end);
}

// Splitting a script into statements. Semicolons inside strings, comments and
// dollar-quoted bodies are not terminators, and MySQL's `DELIMITER` command can
// change what a terminator even is.

import type { DriverId } from '../../shared/connection';
import { isTrivia, syntaxOf, textOf, tokenize, type Token } from './tokenizer';

export interface SqlStatement {
  /** The statement without its terminator or surrounding whitespace. */
  readonly text: string;
  /** Offset of the first character of `text` in the script. */
  readonly start: number;
  /** Offset just past the last character of `text`. */
  readonly end: number;
}

export const DEFAULT_DELIMITER = ';';

/**
 * Statements of a script, in order. Empty statements (a stray `;`, a trailing
 * comment) are left out, so the caller never has to run nothing.
 */
export function splitStatements(sql: string, driver?: DriverId): SqlStatement[] {
  const syntax = syntaxOf(driver);
  const tokens = tokenize(sql, syntax);
  const statements: SqlStatement[] = [];
  let delimiter = DEFAULT_DELIMITER;
  let from = 0;
  let index = 0;

  const body = new TriggerBody(sql, syntax.triggerBodies);

  const push = (start: number, end: number): void => {
    const statement = trimmed(sql, start, end);
    if (statement) {
      statements.push(statement);
    }
    body.reset();
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) {
      break;
    }
    // A `DELIMITER` command belongs to the client, not to the server: it is never
    // part of a statement, and it decides how the following ones end.
    const command = syntax.delimiterCommand ? readDelimiterCommand(sql, tokens, index) : undefined;
    if (command && isStatementStart(tokens, index, from)) {
      push(from, token.start);
      delimiter = command.delimiter;
      from = command.end;
      index = command.nextToken;
      continue;
    }
    body.see(token);
    const terminator = body.open ? undefined : matchDelimiter(sql, token, delimiter);
    if (terminator !== undefined) {
      push(from, token.start);
      from = terminator;
      index = tokenIndexAt(tokens, terminator, index);
      continue;
    }
    index++;
  }
  push(from, sql.length);
  return statements;
}

/** The statement the cursor is in, for "run the statement under the cursor". */
export function statementAt(
  sql: string,
  offset: number,
  driver?: DriverId,
): SqlStatement | undefined {
  const statements = splitStatements(sql, driver);
  if (statements.length === 0) {
    return undefined;
  }
  for (const [position, statement] of statements.entries()) {
    const next = statements[position + 1];
    // A statement owns everything up to the start of the next one, so a cursor
    // sitting after a semicolon still belongs to the statement it just ended.
    const until = next === undefined ? sql.length : next.start;
    if (offset <= until && (position === statements.length - 1 || offset < until)) {
      return statement;
    }
  }
  return statements[statements.length - 1];
}

/** The statements that overlap a selected range. */
export function statementsIn(
  sql: string,
  start: number,
  end: number,
  driver?: DriverId,
): SqlStatement[] {
  if (start === end) {
    const single = statementAt(sql, start, driver);
    return single === undefined ? [] : [single];
  }
  const [from, to] = start <= end ? [start, end] : [end, start];
  return splitStatements(sql, driver).filter(
    (statement) => statement.start < to && statement.end > from,
  );
}

function trimmed(sql: string, start: number, end: number): SqlStatement | undefined {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(sql[from] ?? '')) {
    from++;
  }
  while (to > from && /\s/.test(sql[to - 1] ?? '')) {
    to--;
  }
  if (from >= to) {
    return undefined;
  }
  const text = sql.slice(from, to);
  // A fragment of nothing but comments is not a statement worth running.
  return hasCode(text) ? { text, start: from, end: to } : undefined;
}

function hasCode(text: string): boolean {
  return tokenize(text).some((token) => !isTrivia(token));
}

/**
 * A delimiter may be several characters (`//`, `$$`). Punctuation tokens are one
 * character each, so the match is checked against the source text.
 */
function matchDelimiter(sql: string, token: Token, delimiter: string): number | undefined {
  if (token.kind !== 'punctuation' || !sql.startsWith(delimiter, token.start)) {
    return undefined;
  }
  return token.start + delimiter.length;
}

/** The index of the first token at or after `offset`, searching forward. */
function tokenIndexAt(tokens: readonly Token[], offset: number, from: number): number {
  let index = from;
  while (index < tokens.length && (tokens[index]?.start ?? 0) < offset) {
    index++;
  }
  return Math.max(index, from + 1);
}

interface DelimiterCommand {
  readonly delimiter: string;
  /** Offset just past the command, where the next statement begins. */
  readonly end: number;
  readonly nextToken: number;
}

/** `DELIMITER //` up to the end of its line. */
function readDelimiterCommand(
  sql: string,
  tokens: readonly Token[],
  index: number,
): DelimiterCommand | undefined {
  const token = tokens[index];
  if (token?.kind !== 'word' || textOf(sql, token).toUpperCase() !== 'DELIMITER') {
    return undefined;
  }
  const lineEnd = sql.indexOf('\n', token.end);
  const end = lineEnd === -1 ? sql.length : lineEnd + 1;
  const delimiter = sql.slice(token.end, lineEnd === -1 ? sql.length : lineEnd).trim();
  if (delimiter === '') {
    return undefined;
  }
  let nextToken = index + 1;
  while (nextToken < tokens.length && (tokens[nextToken]?.start ?? 0) < end) {
    nextToken++;
  }
  return { delimiter, end, nextToken };
}

/**
 * Follows `CREATE [TEMP] TRIGGER … BEGIN … END` in dialects that run it as one
 * statement. Inside, `CASE … END` nests too, so both count as blocks; a terminator
 * ends the statement only when every block is closed.
 */
class TriggerBody {
  private words: string[] = [];
  private inTrigger = false;
  private depth = 0;

  constructor(
    private readonly sql: string,
    private readonly enabled: boolean,
  ) {}

  get open(): boolean {
    return this.depth > 0;
  }

  see(token: Token): void {
    if (!this.enabled || token.kind !== 'word') {
      return;
    }
    const word = textOf(this.sql, token).toUpperCase();
    if (this.words.length < 4) {
      this.words.push(word);
      const [first, second, third] = this.words;
      this.inTrigger =
        first === 'CREATE' &&
        (second === 'TRIGGER' ||
          ((second === 'TEMP' || second === 'TEMPORARY') && third === 'TRIGGER'));
    }
    if (!this.inTrigger) {
      return;
    }
    if (word === 'BEGIN' || word === 'CASE') {
      this.depth += 1;
    } else if (word === 'END' && this.depth > 0) {
      this.depth -= 1;
    }
  }

  reset(): void {
    this.words = [];
    this.inTrigger = false;
    this.depth = 0;
  }
}

/** True when nothing but trivia stands between the statement start and this token. */
function isStatementStart(tokens: readonly Token[], index: number, from: number): boolean {
  for (let before = index - 1; before >= 0; before--) {
    const token = tokens[before];
    if ((token?.end ?? 0) <= from) {
      break;
    }
    if (token !== undefined && !isTrivia(token)) {
      return false;
    }
  }
  return true;
}

// Splitting a script into statements. Semicolons inside strings, comments and
// dollar-quoted bodies are not terminators, MySQL's `DELIMITER` command can change
// what a terminator even is, and SQL Server's `GO` lines end batches.

import type { DriverId } from '../../shared/connection';
import { isTrivia, type SqlSyntax, syntaxOf, textOf, tokenize, type Token } from './tokenizer';

export interface SqlStatement {
  /** The statement without its terminator or surrounding whitespace. */
  readonly text: string;
  /** Offset of the first character of `text` in the script. */
  readonly start: number;
  /** Offset just past the last character of `text`. */
  readonly end: number;
}

export const DEFAULT_DELIMITER = ';';

/** How a script is read beyond plain statements. */
export interface SplitOptions {
  /** The terminator in force where the text begins (a script read in parts). */
  readonly delimiter?: string;
  /**
   * Lines that start with `\` where a statement could begin are psql commands
   * (`\connect`, `\restrict`), which pg_dump writes and the server cannot run.
   */
  readonly psqlCommands?: boolean;
  /**
   * Lines that are SQL*Plus commands where a statement could begin (`SET DEFINE OFF`,
   * `PROMPT …`, `WHENEVER SQLERROR …`, `REM …`), which Oracle scripts carry.
   */
  readonly sqlplusCommands?: boolean;
}

/** A piece of a script: a statement for the server, or a line for the psql client. */
export interface ScriptPiece extends SqlStatement {
  readonly kind: 'statement' | 'psql-command';
  /** The terminator in force where the piece begins. */
  readonly delimiter: string;
}

export interface ScriptSplit {
  readonly pieces: ScriptPiece[];
  /** The terminator in force at the end of the text. */
  readonly delimiter: string;
}

/**
 * Statements of a script, in order. Empty statements (a stray `;`, a trailing
 * comment) are left out, so the caller never has to run nothing.
 */
export function splitStatements(sql: string, driver?: DriverId): SqlStatement[] {
  return splitScript(sql, driver).pieces.map(({ text, start, end }) => ({ text, start, end }));
}

/**
 * Pieces of a script with the state a reader needs to go on in the next part:
 * which terminator each piece started with, and which one is in force at the end.
 */
export function splitScript(
  sql: string,
  driver?: DriverId,
  options: SplitOptions = {},
): ScriptSplit {
  const syntax = syntaxOf(driver);
  const tokens = tokenize(sql, syntax);
  const pieces: ScriptPiece[] = [];
  let delimiter = options.delimiter ?? DEFAULT_DELIMITER;
  let from = 0;
  let index = 0;

  const body = new TriggerBody(sql, syntax.triggerBodies);
  const batch = new TsqlBody(sql, syntax.batchSeparator);
  const plsql = new PlsqlBody(sql, syntax.slashTerminator);

  const push = (start: number, end: number): void => {
    const statement = trimmed(sql, start, end, syntax);
    if (statement) {
      pieces.push({ ...statement, kind: 'statement', delimiter });
    }
    body.reset();
    batch.reset();
    plsql.reset();
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
    const psql =
      options.psqlCommands === true
        ? readPsqlCommand(sql, tokens, index)
        : options.sqlplusCommands === true
          ? readSqlplusCommand(sql, tokens, index)
          : undefined;
    if (psql && isStatementStart(tokens, index, from)) {
      push(from, token.start);
      const text = sql.slice(token.start, psql.end).trimEnd();
      pieces.push({
        kind: 'psql-command',
        text,
        start: token.start,
        end: token.start + text.length,
        delimiter,
      });
      from = psql.end;
      index = psql.nextToken;
      continue;
    }
    // `GO` belongs to the client like DELIMITER: it ends whatever is open.
    const separator = syntax.batchSeparator
      ? readBatchSeparator(sql, tokens, index)
      : syntax.slashTerminator
        ? readSlashLine(sql, tokens, index)
        : undefined;
    if (separator) {
      push(from, token.start);
      from = separator.end;
      index = separator.nextToken;
      continue;
    }
    body.see(token);
    batch.see(tokens, index);
    plsql.see(token);
    const terminator =
      body.open ||
      batch.open ||
      plsql.open ||
      (batch.enabled && continuesWithElse(sql, tokens, index))
        ? undefined
        : matchDelimiter(sql, token, delimiter);
    if (terminator !== undefined) {
      push(from, token.start);
      from = terminator;
      index = tokenIndexAt(tokens, terminator, index);
      continue;
    }
    index++;
  }
  push(from, sql.length);
  return { pieces, delimiter };
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

function trimmed(
  sql: string,
  start: number,
  end: number,
  syntax: SqlSyntax,
): SqlStatement | undefined {
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
  return hasCode(text, syntax) ? { text, start: from, end: to } : undefined;
}

function hasCode(text: string, syntax: SqlSyntax): boolean {
  return tokenize(text, syntax).some(
    (token) => !isTrivia(token) || (syntax.executableComments && isExecutableComment(text, token)),
  );
}

// MySQL runs a block comment that opens with `/*!` (MariaDB also `/*M!`) as code;
// mysqldump wraps its session settings in them, `SET FOREIGN_KEY_CHECKS = 0` among them.
function isExecutableComment(text: string, token: Token): boolean {
  return token.kind === 'comment' && /^\/\*M?!/u.test(text.slice(token.start, token.start + 4));
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

interface PsqlCommand {
  /** Offset just past the line, where the next statement begins. */
  readonly end: number;
  readonly nextToken: number;
}

/** `\connect db` and the like: a backslash first on its line, up to the line end. */
function readPsqlCommand(
  sql: string,
  tokens: readonly Token[],
  index: number,
): PsqlCommand | undefined {
  const token = tokens[index];
  if (token?.kind !== 'punctuation' || sql[token.start] !== '\\') {
    return undefined;
  }
  const lineStart = sql.lastIndexOf('\n', token.start - 1) + 1;
  if (sql.slice(lineStart, token.start).trim() !== '') {
    return undefined;
  }
  const lineEnd = sql.indexOf('\n', token.end);
  const end = lineEnd === -1 ? sql.length : lineEnd + 1;
  let nextToken = index + 1;
  while (nextToken < tokens.length && (tokens[nextToken]?.start ?? 0) < end) {
    nextToken++;
  }
  return { end, nextToken };
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

/** A line of nothing but `GO` (and an optional count or comment), from its first token. */
function readBatchSeparator(
  sql: string,
  tokens: readonly Token[],
  index: number,
): DelimiterCommand | undefined {
  const token = tokens[index];
  if (token?.kind !== 'word' || textOf(sql, token).toUpperCase() !== 'GO') {
    return undefined;
  }
  const lineStart = sql.lastIndexOf('\n', token.start - 1) + 1;
  if (sql.slice(lineStart, token.start).trim() !== '') {
    return undefined;
  }
  const lineEnd = sql.indexOf('\n', token.end);
  const end = lineEnd === -1 ? sql.length : lineEnd + 1;
  const rest = sql.slice(token.end, lineEnd === -1 ? sql.length : lineEnd);
  if (!/^\s*(\d+\s*)?(--.*)?$/u.test(rest)) {
    return undefined;
  }
  let nextToken = index + 1;
  while (nextToken < tokens.length && (tokens[nextToken]?.start ?? 0) < end) {
    nextToken++;
  }
  return { delimiter: DEFAULT_DELIMITER, end, nextToken };
}

/** A line of nothing but `/`: SQL*Plus runs what came before it. */
function readSlashLine(
  sql: string,
  tokens: readonly Token[],
  index: number,
): DelimiterCommand | undefined {
  const token = tokens[index];
  if (token?.kind !== 'punctuation' || sql[token.start] !== '/') {
    return undefined;
  }
  const lineStart = sql.lastIndexOf('\n', token.start - 1) + 1;
  const lineEnd = sql.indexOf('\n', token.end);
  const end = lineEnd === -1 ? sql.length : lineEnd + 1;
  if (
    sql.slice(lineStart, token.start).trim() !== '' ||
    sql.slice(token.end, lineEnd === -1 ? sql.length : lineEnd).trim() !== ''
  ) {
    return undefined;
  }
  let nextToken = index + 1;
  while (nextToken < tokens.length && (tokens[nextToken]?.start ?? 0) < end) {
    nextToken++;
  }
  return { delimiter: DEFAULT_DELIMITER, end, nextToken };
}

/** SQL*Plus settings that look like SQL `SET` but belong to the client. */
const SQLPLUS_SETTINGS = new Set([
  'DEFINE',
  'ECHO',
  'SERVEROUTPUT',
  'FEEDBACK',
  'LINESIZE',
  'PAGESIZE',
  'VERIFY',
  'TERMOUT',
  'HEADING',
  'TIMING',
  'SQLBLANKLINES',
  'TRIMSPOOL',
  'TRIMOUT',
  'LONG',
  'NUMWIDTH',
  'COLSEP',
  'ESCAPE',
  'CONCAT',
  'SCAN',
  'AUTOCOMMIT',
  'WRAP',
  'TAB',
]);

const SQLPLUS_COMMANDS = new Set(['REM', 'REMARK', 'PROMPT', 'WHENEVER', 'SPOOL', 'EXIT', 'QUIT']);

/** A SQL*Plus command line, from its first word to the end of its line. */
function readSqlplusCommand(
  sql: string,
  tokens: readonly Token[],
  index: number,
): PsqlCommand | undefined {
  const token = tokens[index];
  if (token?.kind !== 'word') {
    return undefined;
  }
  const word = textOf(sql, token).toUpperCase();
  const next = tokens.slice(index + 1).find((candidate) => !isTrivia(candidate));
  const setting = next?.kind === 'word' ? textOf(sql, next).toUpperCase() : '';
  if (!SQLPLUS_COMMANDS.has(word) && !(word === 'SET' && SQLPLUS_SETTINGS.has(setting))) {
    return undefined;
  }
  const lineStart = sql.lastIndexOf('\n', token.start - 1) + 1;
  if (sql.slice(lineStart, token.start).trim() !== '') {
    return undefined;
  }
  const lineEnd = sql.indexOf('\n', token.end);
  const end = lineEnd === -1 ? sql.length : lineEnd + 1;
  let nextToken = index + 1;
  while (nextToken < tokens.length && (tokens[nextToken]?.start ?? 0) < end) {
    nextToken++;
  }
  return { end, nextToken };
}

/** Words that, after CREATE [OR REPLACE] [EDITIONABLE …], start PL/SQL. */
const PLSQL_UNITS = new Set([
  'PROCEDURE',
  'FUNCTION',
  'PACKAGE',
  'TRIGGER',
  'TYPE',
  'LIBRARY',
  'JAVA',
]);
const EDITIONING = new Set(['EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING']);

/**
 * PL/SQL in an Oracle script: a routine, trigger, package or type body, or an anonymous
 * block (`BEGIN …`, `DECLARE …`), runs as one statement up to the `/` line, its own
 * semicolons included.
 */
class PlsqlBody {
  private words: string[] = [];
  private inBody = false;

  constructor(
    private readonly sql: string,
    private readonly enabled: boolean,
  ) {}

  get open(): boolean {
    return this.inBody;
  }

  see(token: Token): void {
    if (!this.enabled || token.kind !== 'word' || this.words.length >= 6) {
      return;
    }
    this.words.push(textOf(this.sql, token).toUpperCase());
    const [first, ...rest] = this.words;
    if (first === 'BEGIN' || first === 'DECLARE') {
      this.inBody = true;
      return;
    }
    if (first !== 'CREATE') {
      return;
    }
    let at = 0;
    if (rest[at] === 'OR' && rest[at + 1] === 'REPLACE') {
      at += 2;
    }
    if (rest[at] !== undefined && EDITIONING.has(rest[at] ?? '')) {
      at += 1;
    }
    if (rest[at] !== undefined) {
      this.inBody = PLSQL_UNITS.has(rest[at] ?? '');
    }
  }

  reset(): void {
    this.words = [];
    this.inBody = false;
  }
}

/** The first token after `index` that is not trivia. */
function nextCode(tokens: readonly Token[], index: number): Token | undefined {
  for (let next = index + 1; next < tokens.length; next++) {
    const token = tokens[next];
    if (token !== undefined && !isTrivia(token)) {
      return token;
    }
  }
  return undefined;
}

/** `IF … SELECT 1; ELSE SELECT 2;` is one statement: the ELSE goes on with the IF. */
function continuesWithElse(sql: string, tokens: readonly Token[], index: number): boolean {
  const next = nextCode(tokens, index);
  return next?.kind === 'word' && textOf(sql, next).toUpperCase() === 'ELSE';
}

/** Words after BEGIN that start a transaction or a dialog, not a block that END closes. */
const BEGIN_NOT_BLOCK = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION']);

/**
 * T-SQL statements whose semicolons do not end them (SQL Server). A routine or trigger
 * body, and a batch that declares variables, run up to the next `GO`: the server wants
 * the body as one batch, and variables live only as long as theirs. Elsewhere a
 * `BEGIN … END` or `CASE … END` block keeps the statement open until it closes.
 */
class TsqlBody {
  private words: string[] = [];
  private untilBatch = false;
  private depth = 0;

  constructor(
    private readonly sql: string,
    readonly enabled: boolean,
  ) {}

  get open(): boolean {
    return this.untilBatch || this.depth > 0;
  }

  see(tokens: readonly Token[], index: number): void {
    const token = tokens[index];
    if (!this.enabled || token?.kind !== 'word') {
      return;
    }
    const word = textOf(this.sql, token).toUpperCase();
    if (this.words.length < 4) {
      this.words.push(word);
      const [first, second, third, fourth] = this.words;
      const kind = second === 'OR' && third === 'ALTER' ? fourth : second;
      this.untilBatch =
        first === 'DECLARE' ||
        ((first === 'CREATE' || first === 'ALTER') &&
          (kind === 'PROC' || kind === 'PROCEDURE' || kind === 'FUNCTION' || kind === 'TRIGGER'));
    }
    if (word === 'BEGIN' || word === 'CASE' || word === 'END') {
      const after = nextCode(tokens, index);
      const next = after?.kind === 'word' ? textOf(this.sql, after).toUpperCase() : '';
      if (word === 'BEGIN' && !BEGIN_NOT_BLOCK.has(next)) {
        this.depth += 1;
      } else if (word === 'CASE') {
        this.depth += 1;
      } else if (word === 'END' && next !== 'CONVERSATION' && this.depth > 0) {
        this.depth -= 1;
      }
    }
  }

  reset(): void {
    this.words = [];
    this.untilBatch = false;
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

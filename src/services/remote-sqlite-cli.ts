// The second way to change a SQLite file on a server (V13.36): the `sqlite3` program, for a
// server that has it but no Python 3. The Python helper (remote-sqlite-script.ts) stays the
// first choice — its answers are exact. This one talks to the command-line shell of SQLite
// through its standard input and output, which asks for care:
//
// - Nothing the user typed goes into the command line. The command is a constant; the file
//   (as a `file:` address that opens it read-write only, so a wrong path never makes a new
//   empty database) is the first line on standard input, and so is every statement.
// - The shell's own dot-commands (`.shell`, `.system`, `.read`, …) are lines starting with a
//   dot. A statement with such a line, or that is not exactly one complete statement, is
//   refused before it is sent, so no text of a statement can ever be taken for a command.
// - Standard error is merged into standard output (`2>&1`), so an error stays in its place
//   between the markers. Each statement is framed by random markers printed with `.print`.
// - Answers are JSON (`-json`). That is what the shell can do: the names of the columns of a
//   result with no rows are not known (no output mode of the shell prints them), and a BLOB
//   comes back as text, a byte for a character, which cannot be told from text. A whole number
//   beyond 2^53 is kept whole: it is read from the text of the answer before it becomes a JS
//   number (`bigIntegersAsText`). The Python helper has none of the first two limits.
// - The shell cannot say whether a transaction is open. It is followed from the statements
//   (`BEGIN`, `COMMIT`, `ROLLBACK`) and, when it may differ — after a failed statement or a
//   savepoint — asked from the file: `BEGIN` fails exactly when one is open.

import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { DbError } from '../core/errors';
import { msg } from '../core/user-message';
import { leadingKeyword } from '../core/sql/statement-kind';
import { splitStatements } from '../core/sql/split';
import { syntaxOf, tokenize } from '../core/sql/tokenizer';
import { transactionControl } from '../core/sql/transaction-control';
import type { RemoteFileSpec } from './remote-snapshots';
import {
  type Answer,
  cellOf,
  DEFAULT_BUSY_TIMEOUT_MS,
  helperError,
  openFailure,
  RemoteSqliteWriter,
  type SqliteWriter,
  type WriteOutcome,
  type WriterOptions,
} from './remote-sqlite-writer';
import type { ExecChannel, ExecEnd, ExecOpener } from './shell-types';

/** What the shell on the server runs: read the file address from the first line, become `sqlite3`. */
export const CLI_SCRIPT = 'IFS= read -r f && exec sqlite3 -json "$f" 2>&1';

/** The command that is sent; a constant, with nothing of the user's in it. */
export const CLI_COMMAND = `sh -c '${CLI_SCRIPT}'`;

/** `file:/home/me/a%20b.db?mode=rw`: the path, spelled so that nothing in it is special. */
export function fileAddress(path: string): string {
  return `file:${path.split('/').map(encodeURIComponent).join('/')}?mode=rw`;
}

/**
 * Why a statement cannot be sent through the shell, or undefined when it can: it must be one
 * complete statement, with no line the shell would take for one of its own commands.
 */
export function cliRefusal(sql: string): string | undefined {
  if (sql.trim() === '') {
    return 'empty';
  }
  if (tokenize(sql, syntaxOf('sqlite')).some((token) => token.unterminated === true)) {
    return 'incomplete';
  }
  if (splitStatements(sql, 'sqlite').length !== 1) {
    return 'several';
  }
  if (/^[ \t]*[.#]/mu.test(sql)) {
    return 'dot';
  }
  return undefined;
}

function refusalError(reason: string): DbError {
  switch (reason) {
    case 'incomplete':
      return new DbError(
        'syntax',
        msg('The statement is not complete (an open quote or comment): it was not sent'),
      );
    case 'several':
      return new DbError(
        'unsupported',
        msg('Send one statement at a time: the sqlite3 program on the server takes one'),
      );
    case 'dot':
      return new DbError(
        'unsupported',
        msg(
          'A line that starts with a dot or a hash cannot be sent through the sqlite3 program: it would be taken for a command of the program. Move it off the start of the line',
        ),
      );
    default:
      return new DbError('syntax', msg('The statement is empty'));
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** A JSON number, read from where `lastIndex` points. */
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;

/**
 * The answer text with every whole number beyond 2^53 written as `{"i":"digits"}` (the form the
 * Python helper uses), so reading it as JSON loses nothing. Strings, with their keys, are
 * skipped as they are: only a number outside quotes is looked at, and only a whole one (no
 * point, no exponent).
 */
export function bigIntegersAsText(json: string): string {
  let out = '';
  let at = 0;
  while (at < json.length) {
    const char = json.charAt(at);
    if (char === '"') {
      let end = at + 1;
      while (end < json.length && json.charAt(end) !== '"') {
        end += json.charAt(end) === '\\' ? 2 : 1;
      }
      out += json.slice(at, end + 1);
      at = end + 1;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      NUMBER.lastIndex = at;
      const token = NUMBER.exec(json)?.[0] ?? char;
      const big = /^-?\d+$/u.test(token) && token.length > 15 && absolute(BigInt(token)) > MAX_SAFE;
      out += big ? `{"i":"${token}"}` : token;
      at += token.length;
      continue;
    }
    out += char;
    at += 1;
  }
  return out;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

interface Segments {
  /** What the statement printed: JSON rows, or the text of an error. */
  readonly statement: string;
  /** What `SELECT changes()` printed after it. */
  readonly changes: string;
}

const CHANGE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

/** `Runtime error near line 3: UNIQUE constraint failed: t.a (19)` as an answer of the helper kind. */
export function errorAnswer(text: string): Answer {
  const first = text.split(/\r?\n/u)[0] ?? text;
  const match =
    /^(?:Runtime error|Parse error|Error)(?: near line \d+)?: (.*?)(?: \((\d+)\))?$/u.exec(
      first.trim(),
    );
  const message = match?.[1] ?? text.trim();
  const code = match?.[2] === undefined ? undefined : Number(match[2]);
  return {
    ok: false,
    message,
    ...(code === undefined ? {} : { code }),
    ...(/constraint failed/iu.test(message) ? { kind: 'IntegrityError' } : {}),
  };
}

interface Waiting {
  readonly marker: RegExp;
  readonly resolve: (text: string) => void;
  readonly reject: (error: DbError) => void;
}

export class SqliteCliWriter implements SqliteWriter {
  private buffer = '';
  private errors = '';
  private readonly decoder = new StringDecoder('utf8');
  private waiting: Waiting | undefined;
  private ended: ExecEnd | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private txOpen = false;
  /** `close` was asked for: the program ending is then no surprise. */
  private closing = false;
  /** What the program had printed when it ended: its last words, often the reason. */
  private printedAtEnd = '';
  private readonly busyMs: number;

  private constructor(
    private readonly channel: ExecChannel,
    options: WriterOptions,
  ) {
    this.busyMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    channel.onData((chunk, error) => {
      if (error) {
        this.errors = (this.errors + chunk.toString('utf8')).slice(-2000);
        return;
      }
      this.buffer += this.decoder.write(chunk);
      this.look();
    });
    void channel.closed.then((end) => {
      this.ended = end;
      this.printedAtEnd = this.buffer;
      this.txOpen = false;
      this.waiting?.reject(this.endError(end));
      this.waiting = undefined;
    });
  }

  /** Starts the shell on the server, opens the file there for writing and checks it works. */
  static async open(
    opener: ExecOpener,
    spec: RemoteFileSpec,
    path: string,
    options: WriterOptions,
  ): Promise<SqliteCliWriter> {
    const channel = await opener.openExec(spec, CLI_COMMAND);
    const writer = new SqliteCliWriter(channel, options);
    try {
      channel.write(`${fileAddress(path)}\n`);
      channel.write(`.timeout ${writer.busyMs}\n`);
      const check = await writer.exchange('SELECT sqlite_version() AS v');
      if (check.statement.trim() === '' || !check.statement.trim().startsWith('[')) {
        throw helperError(errorAnswer(check.statement), writer.busyMs);
      }
      for (const sql of options.init ?? []) {
        await writer.runNow(sql);
      }
      const version = /"v":"([^"]*)"/u.exec(check.statement)?.[1];
      options.logger.info(
        `Changing ${path} on the server through the sqlite3 program${version === undefined ? '' : ` (SQLite ${version})`}`,
      );
      return writer;
    } catch (error) {
      writer.channel.close();
      throw openFailure(error);
    }
  }

  get alive(): boolean {
    return this.ended === undefined;
  }

  get inTransaction(): boolean {
    return this.txOpen;
  }

  run(sql: string): Promise<WriteOutcome> {
    const next = this.chain.then(
      () => this.runNow(sql),
      () => this.runNow(sql),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.ended === undefined) {
      this.channel.write('.quit\n');
      await Promise.race([
        this.channel.closed.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    this.channel.close();
  }

  abort(): void {
    this.channel.close();
  }

  private async runNow(sql: string): Promise<WriteOutcome> {
    const refusal = cliRefusal(sql);
    if (refusal !== undefined) {
      throw refusalError(refusal);
    }
    const control = transactionControl(sql, 'sqlite');
    const { statement, changes } = await this.exchange(sql);
    const text = statement.trim();
    let rows: Record<string, unknown>[] | undefined;
    if (text.startsWith('[')) {
      try {
        rows = JSON.parse(bigIntegersAsText(text)) as Record<string, unknown>[];
      } catch {
        rows = undefined;
      }
    }
    if (rows === undefined && text !== '') {
      // An error. A statement that failed may or may not have ended the transaction.
      if (this.txOpen || control === 'savepoint') {
        await this.recheck();
      }
      throw helperError(errorAnswer(text), this.busyMs);
    }
    this.follow(control);
    if (control === 'savepoint') {
      await this.recheck();
    }
    const outcome: {
      columns?: { name: string }[];
      rows?: ReturnType<typeof cellOf>[][];
      affectedRows?: number;
    } = {};
    if (rows !== undefined) {
      const names = Object.keys(rows[0] ?? {});
      outcome.columns = names.map((name) => ({ name }));
      outcome.rows = rows.map((row) => names.map((name) => cellOf(row[name])));
    }
    if (CHANGE_KEYWORDS.has(leadingKeyword(sql))) {
      const count = /"c":(\d+)/u.exec(changes)?.[1];
      if (count !== undefined) {
        outcome.affectedRows = Number(count);
      }
    }
    return { ...outcome, inTransaction: this.txOpen };
  }

  /** What the statement did to the transaction, as far as the statement alone says. */
  private follow(control: ReturnType<typeof transactionControl>): void {
    if (control === 'begin') {
      this.txOpen = true;
    } else if (control === 'commit' || control === 'rollback') {
      this.txOpen = false;
    }
  }

  /**
   * Asks the file whether a transaction is open: `BEGIN` fails when one is. When it
   * succeeded there was none, and it is undone at once.
   */
  private async recheck(): Promise<void> {
    if (this.ended !== undefined) {
      return;
    }
    try {
      const begin = await this.exchange('BEGIN');
      if (begin.statement.trim() === '') {
        await this.exchange('ROLLBACK');
        this.txOpen = false;
      } else if (/within a transaction/iu.test(begin.statement)) {
        this.txOpen = true;
      }
    } catch {
      // The link is gone; the end of the channel has said so.
    }
  }

  /** Sends one statement framed by markers and waits for everything it printed. */
  private exchange(sql: string): Promise<Segments> {
    if (this.ended !== undefined) {
      return Promise.reject(this.endError(this.ended));
    }
    const token = randomBytes(8).toString('hex');
    const start = `B-${token}`;
    const middle = `M-${token}`;
    const end = `E-${token}`;
    const done = new Promise<string>((resolve, reject) => {
      this.waiting = { marker: new RegExp(`(?:^|\\n)${end}\\r?\\n`, 'u'), resolve, reject };
    });
    this.channel.write(
      `.print ${start}\n${sql}\n;\n.print ${middle}\nSELECT changes() AS c;\n.print ${end}\n`,
    );
    return done.then((text) => {
      const from = text.indexOf(`${start}\n`);
      const between = text.indexOf(`${middle}\n`, from);
      const after = text.indexOf(`${end}\n`, between);
      return {
        statement: text.slice(from + start.length + 1, between).replace(/\r/gu, ''),
        changes: text.slice(between + middle.length + 1, after),
      };
    });
  }

  private look(): void {
    const waiting = this.waiting;
    if (waiting === undefined) {
      return;
    }
    if (waiting.marker.test(this.buffer)) {
      const text = this.buffer;
      this.buffer = '';
      this.waiting = undefined;
      waiting.resolve(text);
    }
  }

  private endError(end: ExecEnd): DbError {
    const said = `${this.errors}\n${this.printedAtEnd}`.trim();
    if (/unable to open database/iu.test(said)) {
      // Said before the first statement: the file cannot be opened for changes.
      return new DbError('permission-denied', said.split('\n')[0] ?? said);
    }
    if (end.code === 127 || /not found|no such file/iu.test(said)) {
      return new DbError('unsupported', msg('The sqlite3 program was not found on the server'));
    }
    if (end.reason === 'closed' || this.closing) {
      return new DbError('cancelled', msg('The connection to the file on the server was closed'));
    }
    if (end.reason === 'dropped') {
      return new DbError(
        'connection-failed',
        msg('The connection to the server was lost; a transaction that was open is undone there'),
      );
    }
    return new DbError(
      'connection-failed',
      msg('The sqlite3 program on the server stopped (exit code {0}): {1}', end.code ?? '?', said),
    );
  }
}

/**
 * Opens the writer for a file on a server: the Python helper when the server has Python 3,
 * otherwise the `sqlite3` program; and a plain word about it when it has neither.
 */
export async function openRemoteWriter(
  opener: ExecOpener,
  spec: RemoteFileSpec,
  path: string,
  options: WriterOptions,
): Promise<SqliteWriter> {
  try {
    return await RemoteSqliteWriter.open(opener, spec, path, options);
  } catch (error) {
    if (!(error instanceof DbError) || error.code !== 'unsupported') {
      throw error;
    }
    options.logger.info('Python 3 was not found on the server; trying the sqlite3 program');
    try {
      return await SqliteCliWriter.open(opener, spec, path, options);
    } catch (second) {
      if (second instanceof DbError && second.code === 'unsupported') {
        throw new DbError(
          'unsupported',
          msg(
            'Changing the file on the server needs Python 3 (its sqlite3 module) or the sqlite3 program there, and neither was found',
          ),
          { cause: second },
        );
      }
      throw second;
    }
  }
}

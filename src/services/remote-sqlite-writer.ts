// Changing a SQLite file that lives on a server (V13.33), without sending the file back: a
// small Python 3 helper runs there over SSH (remote-sqlite-script.ts), opens the file with its
// own SQLite and carries out the statements it is sent. SQLite itself takes the locks and
// keeps the -wal file, so a program using the file on the server is never overwritten; at
// worst a statement waits for it (busy timeout) or fails with "database is locked".
// The helper stays open for the life of one session, so a transaction (BEGIN … COMMIT) really
// spans statements, exactly as it does for a local file.

import { DbError, type DbErrorCode } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { msg } from '../core/user-message';
import { binaryValue } from '../drivers/common/values';
import type { ResultColumn } from '../drivers/driver';
import type { CellValue } from '../shared/cell-value';
import { helperCommand } from './remote-sqlite-script';
import type { RemoteFileSpec } from './remote-snapshots';
import type { ExecChannel, ExecEnd, ExecOpener } from './shell-types';

/** How long a statement waits for a program that holds the file, unless told otherwise. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** What came back from one statement. */
export interface WriteOutcome {
  /** Set for a statement that returns rows (`INSERT … RETURNING`). */
  readonly columns?: readonly ResultColumn[];
  readonly rows?: readonly (readonly CellValue[])[];
  readonly affectedRows?: number;
  /** A transaction is open after the statement. */
  readonly inTransaction: boolean;
}

/** What a session needs of whatever changes the file on the server (Python helper or sqlite3). */
export interface SqliteWriter {
  readonly alive: boolean;
  /** A transaction is open, as far as the writer knows after its last statement. */
  readonly inTransaction: boolean;
  run(sql: string): Promise<WriteOutcome>;
  close(): Promise<void>;
  /** Drops the link at once: the server undoes what is not committed. */
  abort(): void;
}

export interface WriterOptions {
  readonly busyTimeoutMs?: number;
  /** Run once after opening: the connection's own settings, e.g. `PRAGMA foreign_keys = ON`. */
  readonly init?: readonly string[];
  readonly logger: Logger;
}

export interface Answer {
  readonly id?: number;
  readonly ok: boolean;
  readonly message?: string;
  readonly kind?: string;
  readonly name?: string | null;
  readonly code?: number | null;
  readonly cols?: string[] | null;
  readonly rows?: unknown[][] | null;
  readonly changes?: number | null;
  readonly tx?: boolean;
  readonly version?: string;
  readonly python?: string;
}

/** The ASCII spelling of a request line: every character above 0x7f becomes \uXXXX. */
export function requestLine(request: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(request).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

/** SQLite's primary result codes the helper may report (extended code & 0xff). */
const BY_PRIMARY: Readonly<Record<number, DbErrorCode>> = {
  3: 'permission-denied',
  5: 'busy',
  6: 'busy',
  8: 'permission-denied',
  9: 'cancelled',
  10: 'connection-failed',
  11: 'internal',
  14: 'connection-failed',
  19: 'constraint',
  23: 'permission-denied',
  26: 'connection-failed',
};

export function classify(answer: Answer): DbErrorCode {
  const message = (answer.message ?? '').toLowerCase();
  if (message.includes('database is locked') || message.includes('database table is locked')) {
    return 'busy';
  }
  if (message.includes('readonly') || message.includes('read-only')) {
    return 'permission-denied';
  }
  if (message.includes('unable to open database file')) {
    return 'permission-denied';
  }
  if (typeof answer.code === 'number') {
    const primary = answer.code & 0xff;
    if (primary !== 1) {
      return BY_PRIMARY[primary] ?? 'internal';
    }
  }
  if (answer.kind === 'IntegrityError' || message.includes('constraint failed')) {
    return 'constraint';
  }
  if (message.includes('syntax error') || message.includes('unrecognized token')) {
    return 'syntax';
  }
  if (message.includes('no such') || message.includes('already exists')) {
    return message.includes('already exists') ? 'constraint' : 'not-found';
  }
  return 'internal';
}

/** An error the helper reported, as the app's own error; the reason is spelled out. */
export function helperError(answer: Answer, busyMs: number): DbError {
  const code = classify(answer);
  const text = answer.message ?? 'unknown error';
  if (code === 'busy') {
    return new DbError(
      'busy',
      msg(
        'The database on the server is in use by another program (waited {0} s): {1}',
        Math.round(busyMs / 100) / 10,
        text,
      ),
      { driverCode: answer.name ?? answer.code ?? undefined },
    );
  }
  if (code === 'permission-denied') {
    return new DbError(
      'permission-denied',
      msg('This user may not change the file on the server, or the folder it lies in: {0}', text),
      { driverCode: answer.name ?? answer.code ?? undefined },
    );
  }
  return new DbError(code, text, { driverCode: answer.name ?? answer.code ?? undefined });
}

/** A cell of the helper's answer as a cell of the grid. */
export function cellOf(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'object') {
    const tagged = value as { readonly b?: unknown; readonly i?: unknown };
    if (typeof tagged.b === 'string') {
      return binaryValue(new Uint8Array(Buffer.from(tagged.b, 'base64')));
    }
    if (typeof tagged.i === 'string') {
      return { kind: 'bigint', text: tagged.i };
    }
  }
  return { kind: 'json', text: JSON.stringify(value) };
}

/** SQLite says the same for a file that is not there and one that may not be opened. */
export function openFailure(error: unknown): unknown {
  if (error instanceof DbError && error.code === 'permission-denied') {
    return new DbError(
      'permission-denied',
      msg(
        'The file could not be opened for changes on the server: it may not exist, or this user may not write to it and its folder ({0})',
        error.message,
      ),
      { cause: error },
    );
  }
  return error;
}

interface Pending {
  readonly resolve: (answer: Answer) => void;
  readonly reject: (error: DbError) => void;
}

export class RemoteSqliteWriter implements SqliteWriter {
  private buffer = '';
  private errors = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ended: ExecEnd | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly busyMs: number;
  private txOpen = false;

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
      this.hear(chunk.toString('latin1'));
    });
    void channel.closed.then((end) => {
      this.ended = end;
      this.txOpen = false;
      const error = this.endError(end);
      for (const waiting of this.pending.values()) {
        waiting.reject(error);
      }
      this.pending.clear();
    });
  }

  /** Starts the helper on the server and opens the file for writing. */
  static async open(
    opener: ExecOpener,
    spec: RemoteFileSpec,
    path: string,
    options: WriterOptions,
  ): Promise<RemoteSqliteWriter> {
    const channel = await opener.openExec(spec, helperCommand());
    const writer = new RemoteSqliteWriter(channel, options);
    try {
      const answer = await writer.request({
        op: 'open',
        path,
        busy: writer.busyMs,
        init: options.init ?? [],
      });
      options.logger.info(
        `Changing ${path} on the server through Python ${answer.python ?? '?'}, SQLite ${answer.version ?? '?'}`,
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

  /** A transaction is open, as the file on the server said after its last answer. */
  get inTransaction(): boolean {
    return this.txOpen;
  }

  /** Runs one statement; they follow one another even if called together. */
  run(sql: string): Promise<WriteOutcome> {
    const next = this.chain.then(
      () => this.runNow(sql),
      () => this.runNow(sql),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Ends the helper: the file is closed on the server, and a transaction left open is undone. */
  async close(): Promise<void> {
    if (this.ended === undefined) {
      try {
        await Promise.race([
          this.request({ op: 'close' }),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // The helper is gone already.
      }
    }
    this.channel.close();
  }

  /** Drops the link at once: the server undoes what is not committed. */
  abort(): void {
    this.channel.close();
  }

  private async runNow(sql: string): Promise<WriteOutcome> {
    const answer = await this.request({ op: 'exec', sql });
    const columns = answer.cols?.map((name) => ({ name }));
    return {
      ...(columns === undefined ? {} : { columns }),
      ...(answer.rows === undefined || answer.rows === null
        ? {}
        : { rows: answer.rows.map((row) => row.map(cellOf)) }),
      ...(answer.changes === undefined || answer.changes === null
        ? {}
        : { affectedRows: answer.changes }),
      inTransaction: answer.tx === true,
    };
  }

  private async request(request: Readonly<Record<string, unknown>>): Promise<Answer> {
    if (this.ended !== undefined) {
      throw this.endError(this.ended);
    }
    const id = this.nextId++;
    const answer = await new Promise<Answer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.write(requestLine({ ...request, id }));
    });
    if (!answer.ok) {
      throw helperError(answer, this.busyMs);
    }
    return answer;
  }

  private hear(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== '') {
        this.take(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private take(line: string): void {
    let answer: Answer;
    try {
      answer = JSON.parse(line) as Answer;
    } catch {
      // Not ours: a greeting the server's shell printed. Nothing waits for it.
      return;
    }
    if (typeof answer.tx === 'boolean') {
      this.txOpen = answer.tx;
    }
    const waiting = answer.id === undefined ? undefined : this.pending.get(answer.id);
    if (waiting !== undefined && answer.id !== undefined) {
      this.pending.delete(answer.id);
      waiting.resolve(answer);
    }
  }

  /** Why the helper is gone, in words for the user. */
  private endError(end: ExecEnd): DbError {
    const said = this.errors.trim();
    if (end.code === 127 || /not found|no such file/i.test(said)) {
      return new DbError(
        'unsupported',
        msg(
          'Changing the file on the server needs Python 3 there (its sqlite3 module does the work), and python3 was not found',
        ),
      );
    }
    if (end.reason === 'closed') {
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
      msg('The helper on the server stopped (exit code {0}): {1}', end.code ?? '?', said),
    );
  }
}

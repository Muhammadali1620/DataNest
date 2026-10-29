// Runs a SQL file of any size (V5.1): the text is read in parts and each statement
// goes to the server as soon as it is complete, on a session of its own, so the
// editors stay free and memory holds one statement, not the file.

import { type DbErrorCode, errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { ScriptReader, type ScriptItem } from '../core/sql/script-reader';
import type { DriverId } from '../shared/connection';
import type { Session } from '../drivers/driver';
import { ConnectionManager, type SessionTarget } from './connection-manager';

/** A part of the file: its text and how many bytes of the file it took. */
export interface ScriptChunk {
  readonly text: string;
  readonly bytes: number;
}

export interface ScriptProgress {
  /** Bytes of the file read so far. */
  readonly bytes: number;
  /** Statements sent to the server, failed ones included. */
  readonly statements: number;
  readonly failed: number;
}

/** Why a piece of the script did not do its job. */
export type ScriptFailureKind =
  /** The server refused the statement. */
  | 'error'
  /** `COPY … FROM stdin`: its rows are not loaded. */
  | 'copy-from-stdin'
  /** A psql command that changes where the rest goes (`\connect`). */
  | 'psql-command';

export interface ScriptFailure {
  readonly kind: ScriptFailureKind;
  /** Line of the file where the statement starts, from 1. */
  readonly line: number;
  /** The beginning of the statement, for the report. */
  readonly statement: string;
  /** The server's message; only for `error`. */
  readonly message?: string;
  readonly code?: DbErrorCode;
}

export interface ScriptReport {
  readonly outcome: 'done' | 'stopped' | 'cancelled';
  /** The failure that stopped the run; only with outcome `stopped`. */
  readonly stoppedAt?: ScriptFailure;
  /** Statements sent to the server, failed ones included. */
  readonly statements: number;
  readonly failedCount: number;
  /** The first failures, in file order; at most MAX_REPORTED_FAILURES. */
  readonly failures: readonly ScriptFailure[];
  /** psql commands that were left out because they mean nothing to the server. */
  readonly skipped: readonly { readonly line: number; readonly text: string }[];
  readonly affectedRows: number;
  /** The script ended inside a transaction; closing the session rolled it back. */
  readonly rolledBack: boolean;
  readonly bytes: number;
  readonly durationMs: number;
}

export interface ScriptRunRequest {
  readonly target: SessionTarget;
  readonly chunks: AsyncIterable<ScriptChunk>;
  /** Keep going after a failed statement instead of stopping there. */
  readonly continueOnError: boolean;
  readonly onProgress?: (progress: ScriptProgress) => void;
  readonly signal?: AbortSignal;
}

export interface ScriptRunnerDeps {
  readonly manager: Pick<ConnectionManager, 'acquire' | 'release' | 'driverOf'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** A report lists this many failures; the count goes on. */
export const MAX_REPORTED_FAILURES = 1000;
/** How much of a statement a failure keeps. */
export const STATEMENT_EXCERPT = 300;

/** psql commands that only change how psql itself behaves; leaving them out is harmless. */
const HARMLESS_PSQL = /^\\(restrict|unrestrict|set|unset|echo|encoding|pset|timing|qecho)\b/u;

/**
 * SQL*Plus commands of an Oracle script (V6.4), all about the client: its settings,
 * messages and spool file. WHENEVER SQLERROR is what the runner does anyway unless asked
 * to go on, and EXIT is how such a script usually ends.
 */
const HARMLESS_SQLPLUS = /^(SET|PROMPT|REM|REMARK|SPOOL|WHENEVER|EXIT|QUIT)\b/iu;

let nextRun = 1;

export class ScriptRunner {
  private readonly manager: ScriptRunnerDeps['manager'];
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: ScriptRunnerDeps) {
    this.manager = deps.manager;
    this.logger = deps.logger.child('script');
    this.now = deps.now ?? Date.now;
  }

  async run(request: ScriptRunRequest): Promise<ScriptReport> {
    const started = this.now();
    const driver = await this.manager.driverOf(request.target.connectionId);
    const owner = ConnectionManager.taskOwner(`script-${nextRun++}`);
    const session = await this.manager.acquire(owner, request.target);
    const state = new RunState(request);
    let rolledBack: boolean;
    try {
      await this.runAll(session, driver.id, request, state);
    } finally {
      const transaction = session.transactionState?.();
      rolledBack = transaction === 'open' || transaction === 'failed';
      await this.manager.release(owner);
    }
    const report: ScriptReport = {
      outcome: state.outcome,
      ...(state.stoppedAt === undefined ? {} : { stoppedAt: state.stoppedAt }),
      statements: state.statements,
      failedCount: state.failedCount,
      failures: state.failures,
      skipped: state.skipped,
      affectedRows: state.affectedRows,
      rolledBack,
      bytes: state.bytes,
      durationMs: this.now() - started,
    };
    this.logger.info(
      `Script ${report.outcome}: ${report.statements} statements, ${report.failedCount} failed`,
    );
    return report;
  }

  private async runAll(
    session: Session,
    driver: DriverId,
    request: ScriptRunRequest,
    state: RunState,
  ): Promise<void> {
    const reader = new ScriptReader(driver);
    const cancel = (): void => {
      session.cancel().catch((error: unknown) => {
        this.logger.warn('Cancelling the running statement failed', error);
      });
    };
    request.signal?.addEventListener('abort', cancel);
    try {
      for await (const chunk of request.chunks) {
        if (!(await this.runItems(session, reader.push(chunk.text), request, state))) {
          return;
        }
        state.bytes += chunk.bytes;
        state.progress();
      }
      await this.runItems(session, reader.end(), request, state);
    } finally {
      request.signal?.removeEventListener('abort', cancel);
    }
  }

  /** False when the run must not go on: stopped, cancelled or the link is gone. */
  private async runItems(
    session: Session,
    items: readonly ScriptItem[],
    request: ScriptRunRequest,
    state: RunState,
  ): Promise<boolean> {
    for (const item of items) {
      if (aborted(request.signal)) {
        state.outcome = 'cancelled';
        return false;
      }
      if (
        item.kind === 'psql-command' &&
        (HARMLESS_PSQL.test(item.text) || HARMLESS_SQLPLUS.test(item.text))
      ) {
        state.skipped.push({ line: item.line, text: item.text });
        continue;
      }
      if (item.kind !== 'statement') {
        const failure: ScriptFailure = {
          kind: item.kind,
          line: item.line,
          statement: excerpt(item.text),
        };
        state.fail(failure);
        if (!request.continueOnError) {
          state.stop(failure);
          return false;
        }
        continue;
      }
      state.statements += 1;
      try {
        state.affectedRows += await execute(session, item.text);
      } catch (error) {
        const dbError = toDbError(error);
        if (aborted(request.signal)) {
          state.outcome = 'cancelled';
          return false;
        }
        const failure: ScriptFailure = {
          kind: 'error',
          line: item.line,
          statement: excerpt(item.text),
          message: errorMessage(dbError),
          code: dbError.code,
        };
        state.fail(failure);
        // A lost link takes the session's state (USE, SET, transaction) with it, so
        // going on over a new connection would run the rest somewhere else.
        if (!request.continueOnError || dbError.code === 'connection-failed') {
          state.stop(failure);
          return false;
        }
      }
      state.progress();
    }
    return true;
  }
}

class RunState {
  outcome: ScriptReport['outcome'] = 'done';
  stoppedAt: ScriptFailure | undefined;
  statements = 0;
  failedCount = 0;
  readonly failures: ScriptFailure[] = [];
  readonly skipped: { line: number; text: string }[] = [];
  affectedRows = 0;
  bytes = 0;

  constructor(private readonly request: ScriptRunRequest) {}

  fail(failure: ScriptFailure): void {
    this.failedCount += 1;
    if (this.failures.length < MAX_REPORTED_FAILURES) {
      this.failures.push(failure);
    }
  }

  stop(failure: ScriptFailure): void {
    this.outcome = 'stopped';
    this.stoppedAt = failure;
  }

  progress(): void {
    this.request.onProgress?.({
      bytes: this.bytes,
      statements: this.statements,
      failed: this.failedCount,
    });
  }
}

/** Runs one statement to its end; rows are read and dropped. Returns the affected rows. */
async function execute(session: Session, sql: string): Promise<number> {
  let affected = 0;
  for await (const event of session.execute(sql)) {
    if (event.kind === 'done' && event.affectedRows !== undefined) {
      affected += event.affectedRows;
    }
  }
  return affected;
}

/** A function, so the check is read again after every await rather than narrowed away. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= STATEMENT_EXCERPT ? flat : `${flat.slice(0, STATEMENT_EXCERPT - 1)}…`;
}

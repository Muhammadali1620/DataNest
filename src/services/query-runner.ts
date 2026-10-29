// Runs the statements of one editor against its connection, one at a time, and
// puts what comes back into the ResultStore.

import { type Disposable, toDisposable } from '../core/disposable';
import { DbError, errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { SqlStatement } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import { guessErrorPosition } from '../core/sql/error-position';
import type { ResultEdit } from '../core/model/editability';
import type { ResultColumn, Session } from '../drivers/driver';
import { analyzeEditability } from './result-editability';
import { ConnectionManager, type SessionTarget } from './connection-manager';
import type { MetadataCache } from './metadata-cache';
import type { HistoryRecorder } from './history';
import { needsBegin } from './manual-commit';
import type { ResultStore, ResultSummary, ResultRow } from './result-store';

/** Limits the user controls through settings (V1.25). */
export interface QueryLimits {
  /** Largest number of rows one statement may bring back. */
  rowLimit(): number;
  /** Milliseconds a statement may run before it is cancelled; 0 means no limit. */
  timeoutMs?(connectionId: string): number;
}

export interface QueryRunnerDeps {
  readonly manager: ConnectionManager;
  readonly results: ResultStore;
  readonly cache: MetadataCache;
  readonly limits: QueryLimits;
  /** Where finished statements are noted for the query history. */
  readonly history?: HistoryRecorder;
  readonly logger: Logger;
}

export interface RunRequest {
  readonly documentUri: string;
  readonly target: SessionTarget;
  readonly statements: readonly SqlStatement[];
  /** Stop the whole run on the first failure. True is what an editor wants. */
  readonly stopOnError?: boolean;
  /**
   * Manual commit (V4.8): open a transaction before the first changing statement,
   * and leave it open for the user to commit or roll back.
   */
  readonly manualCommit?: boolean;
}

export interface RunOutcome {
  readonly results: ResultSummary[];
  /** True when the user cancelled before every statement had run. */
  readonly cancelled: boolean;
  /** Statements that never ran because an earlier one failed or it was cancelled. */
  readonly skipped: number;
}

interface ActiveRun {
  cancelled: boolean;
  /** Set when the cancel came from the timeout rather than from the user. */
  timedOut: boolean;
  readonly owner: string;
  /** When the run started, so the status bar can show a timer. */
  readonly startedAt: number;
}

/** One run per document: a session executes one statement at a time. */
export class QueryRunner {
  private readonly deps: QueryRunnerDeps;
  private readonly logger: Logger;
  private readonly active = new Map<string, ActiveRun>();
  private readonly listeners = new Set<(documentUri: string) => void>();

  constructor(deps: QueryRunnerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('query');
  }

  isRunning(documentUri: string): boolean {
    return this.active.has(documentUri);
  }

  /** When the run of a document started, for the elapsed-time display. */
  startedAt(documentUri: string): number | undefined {
    return this.active.get(documentUri)?.startedAt;
  }

  /** Fires with the document whose run started or finished. */
  onDidChangeRunning(listener: (documentUri: string) => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  /** Documents with a statement in flight. */
  runningDocuments(): string[] {
    return [...this.active.keys()];
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    if (request.statements.length === 0) {
      return { results: [], cancelled: false, skipped: 0 };
    }
    if (this.active.has(request.documentUri)) {
      throw new DbError('busy', 'A query is already running in this editor');
    }
    const owner = ConnectionManager.editorOwner(request.documentUri);
    const run: ActiveRun = { cancelled: false, timedOut: false, owner, startedAt: Date.now() };
    this.active.set(request.documentUri, run);
    this.notify(request.documentUri);
    const stopOnError = request.stopOnError ?? true;
    const results: ResultSummary[] = [];
    let index = 0;
    try {
      for (const statement of request.statements) {
        if (run.cancelled) {
          break;
        }
        index++;
        const summary = await this.runOne(request, statement, run);
        results.push(summary);
        if (summary.error !== undefined && stopOnError) {
          break;
        }
      }
      return {
        results,
        cancelled: run.cancelled,
        skipped: request.statements.length - index,
      };
    } finally {
      this.active.delete(request.documentUri);
      this.notify(request.documentUri);
    }
  }

  /**
   * Asks the server to stop the statement in flight. The run ends with whatever
   * it had already collected; nothing is thrown at the caller of `run`.
   */
  async cancel(documentUri: string): Promise<void> {
    const run = this.active.get(documentUri);
    if (run === undefined) {
      return;
    }
    run.cancelled = true;
    try {
      // Only a session that is already open can be cancelled; opening one here
      // would be pointless and could even outlive the run.
      await this.deps.manager.sessionOf(run.owner)?.cancel();
    } catch (error) {
      // Cancelling is best effort: the statement may have just finished.
      this.logger.debug(`Cancelling in ${documentUri} failed: ${errorMessage(error)}`);
    }
  }

  private async editabilityOf(
    request: RunRequest,
    session: Session,
    sql: string,
    columns: readonly ResultColumn[],
  ): Promise<ResultEdit> {
    const driver = await this.deps.manager.driverOf(request.target.connectionId);
    return await analyzeEditability(
      {
        metadata: this.deps.cache.wrap(request.target.connectionId, session.metadata),
        syntax: syntaxOf(driver.id),
        schemas: driver.capabilities.schemas,
        logger: this.logger,
        readOnly: this.deps.manager.isReadOnly(request.target.connectionId),
      },
      sql,
      columns.map((column) => column.name),
    );
  }

  /** In manual mode, the transaction a changing statement needs, opened first. */
  private async beginIfNeeded(request: RunRequest, session: Session, sql: string): Promise<void> {
    const driver = await this.deps.manager.driverOf(request.target.connectionId);
    if (!needsBegin(sql, driver.id, session.transactionState?.())) {
      return;
    }
    for await (const _event of session.execute(driver.dialect.transaction.begin)) {
      // BEGIN returns nothing worth keeping; a failure becomes this statement's error.
    }
    this.logger.debug(`Opened a transaction in ${request.documentUri} (manual commit)`);
  }

  /** Notes a finished statement; the history must never be able to fail a query. */
  private remember(
    request: RunRequest,
    sql: string,
    outcome: { durationMs: number; rows?: number; affected?: number; error?: string },
  ): void {
    try {
      this.deps.history?.record({
        sql,
        connectionId: request.target.connectionId,
        database: request.target.database,
        ...outcome,
      });
    } catch (error) {
      this.logger.warn('Could not record the statement in the history', error);
    }
  }

  private notify(documentUri: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(documentUri);
      } catch (error) {
        this.logger.warn('A run listener failed', error);
      }
    }
  }

  private async runOne(
    request: RunRequest,
    statement: SqlStatement,
    run: ActiveRun,
  ): Promise<ResultSummary> {
    const rowLimit = Math.max(1, Math.trunc(this.deps.limits.rowLimit()));
    const started = Date.now();
    let columns: readonly ResultColumn[] = [];
    const rows: ResultRow[] = [];
    let affectedRows: number | undefined;
    let truncated = false;
    const timeoutMs = Math.max(
      0,
      Math.trunc(this.deps.limits.timeoutMs?.(request.target.connectionId) ?? 0),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await this.deps.manager.acquire(run.owner, request.target);
      if (request.manualCommit === true) {
        await this.beginIfNeeded(request, session, statement.text);
      }
      if (timeoutMs > 0) {
        // The server is asked to stop; what comes back is reported as a timeout.
        timer = setTimeout(() => {
          run.timedOut = true;
          void this.cancel(request.documentUri);
        }, timeoutMs);
      }
      // A batch or procedure may return several sets of rows; the first is shown, and
      // the others are not mixed into it under its column names.
      let sets = 0;
      for await (const event of session.execute(statement.text, { rowLimit })) {
        switch (event.kind) {
          case 'columns':
            sets += 1;
            if (sets === 1) {
              columns = event.columns;
            }
            break;
          case 'rows':
            if (sets > 1) {
              break;
            }
            for (const row of event.rows) {
              if (rows.length >= rowLimit) {
                truncated = true;
                break;
              }
              rows.push(row);
            }
            break;
          case 'done':
            affectedRows = event.affectedRows;
            break;
        }
      }
      // The structure may have changed, so stale metadata must not survive.
      this.deps.cache.noteStatement(request.target.connectionId, statement.text);
      const edit =
        columns.length === 0
          ? undefined
          : await this.editabilityOf(request, session, statement.text, columns);
      this.remember(request, statement.text, {
        durationMs: Date.now() - started,
        ...(columns.length > 0 ? { rows: rows.length } : {}),
        ...(affectedRows === undefined ? {} : { affected: affectedRows }),
      });
      return this.deps.results.add({
        documentUri: request.documentUri,
        statement: statement.text,
        statementStart: statement.start,
        origin: { target: request.target, owner: run.owner },
        columns,
        rows,
        truncated,
        ...(affectedRows === undefined ? {} : { affectedRows }),
        durationMs: Date.now() - started,
        ...(edit === undefined ? {} : { edit }),
      });
    } catch (error) {
      const dbError = toDbError(error);
      this.logger.warn(`Statement failed: ${dbError.message}`, dbError);
      // A cancelled statement is an outcome, not a crash: it is stored like any other.
      // A cancel the timeout asked for is reported as a timeout, which is the
      // difference the user cares about.
      const timedOut = run.timedOut && (dbError.code === 'cancelled' || dbError.code === 'timeout');
      // Most servers do not say where the problem is; the message often does.
      const driverId = await this.deps.manager
        .driverOf(request.target.connectionId)
        .then((driver) => driver.id)
        .catch(() => undefined);
      const position =
        dbError.position ?? guessErrorPosition(dbError.message, statement.text, driverId);
      this.remember(request, statement.text, {
        durationMs: Date.now() - started,
        error: timedOut ? 'Timed out' : dbError.message,
      });
      return this.deps.results.add({
        documentUri: request.documentUri,
        statement: statement.text,
        statementStart: statement.start,
        columns,
        rows,
        truncated,
        durationMs: Date.now() - started,
        error: {
          code: timedOut ? 'timeout' : dbError.code,
          message: timedOut
            ? `Cancelled after ${Math.round(timeoutMs / 1000)} s (the query timeout of the connection or datanest.queryTimeout)`
            : dbError.message,
          ...(position === undefined ? {} : { position }),
        },
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

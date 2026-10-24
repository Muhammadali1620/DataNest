// Runs the statements of one editor against its connection, one at a time, and
// puts what comes back into the ResultStore.

import { DbError, errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { SqlStatement } from '../core/sql/split';
import type { ResultColumn } from '../drivers/driver';
import { ConnectionManager, type SessionTarget } from './connection-manager';
import type { MetadataCache } from './metadata-cache';
import type { ResultStore, ResultSummary, ResultRow } from './result-store';

/** Limits the user controls through settings (V1.25). */
export interface QueryLimits {
  /** Largest number of rows one statement may bring back. */
  rowLimit(): number;
}

export interface QueryRunnerDeps {
  readonly manager: ConnectionManager;
  readonly results: ResultStore;
  readonly cache: MetadataCache;
  readonly limits: QueryLimits;
  readonly logger: Logger;
}

export interface RunRequest {
  readonly documentUri: string;
  readonly target: SessionTarget;
  readonly statements: readonly SqlStatement[];
  /** Stop the whole run on the first failure. True is what an editor wants. */
  readonly stopOnError?: boolean;
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
  readonly owner: string;
}

/** One run per document: a session executes one statement at a time. */
export class QueryRunner {
  private readonly deps: QueryRunnerDeps;
  private readonly logger: Logger;
  private readonly active = new Map<string, ActiveRun>();

  constructor(deps: QueryRunnerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('query');
  }

  isRunning(documentUri: string): boolean {
    return this.active.has(documentUri);
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
    const run: ActiveRun = { cancelled: false, owner };
    this.active.set(request.documentUri, run);
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
    try {
      const session = await this.deps.manager.acquire(run.owner, request.target);
      for await (const event of session.execute(statement.text, { rowLimit })) {
        switch (event.kind) {
          case 'columns':
            columns = event.columns;
            break;
          case 'rows':
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
      return this.deps.results.add({
        documentUri: request.documentUri,
        statement: statement.text,
        columns,
        rows,
        truncated,
        ...(affectedRows === undefined ? {} : { affectedRows }),
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const dbError = toDbError(error);
      this.logger.warn(`Statement failed: ${dbError.message}`, dbError);
      // A cancelled statement is an outcome, not a crash: it is stored like any other.
      return this.deps.results.add({
        documentUri: request.documentUri,
        statement: statement.text,
        columns,
        rows,
        truncated,
        durationMs: Date.now() - started,
        error: {
          code: dbError.code,
          message: dbError.message,
          ...(dbError.position === undefined ? {} : { position: dbError.position }),
        },
      });
    }
  }
}

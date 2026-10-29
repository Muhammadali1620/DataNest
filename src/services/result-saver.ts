// Saves the pending edits of a result: builds the statements, runs them in one
// transaction on the session that produced the rows, and re-reads the rows. Either
// every change is saved or none is; a failure keeps the pending edits for another try.

import { errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { Dialect, ResultColumn, Session } from '../drivers/driver';
import { buildChangeStatements, type ChangeStatement } from './change-sql';
import type { ConnectionManager } from './connection-manager';
import type { ResultRow, ResultStore, ResultSummary } from './result-store';

export interface SaveFailure {
  readonly ok: false;
  /** `busy`, `not-editable`, `no-changes`, `row-missing`, or a database error code. */
  readonly code: string;
  readonly message: string;
  /** The statement that failed, when one did. */
  readonly statement?: string;
}

export type SaveOutcome =
  | {
      readonly ok: true;
      readonly statements: number;
      /** False when the changes were saved but the rows could not be read again. */
      readonly refreshed: boolean;
      /**
       * True when the session already had a transaction open (V4.8): the changes
       * joined it and wait for the user's Commit or Rollback.
       */
      readonly inTransaction: boolean;
    }
  | SaveFailure;

export type PreviewOutcome = { readonly ok: true; readonly sql: string } | SaveFailure;

/** The part of the connection manager the saver uses. */
export type SaverConnections = Pick<ConnectionManager, 'acquire' | 'driverOf' | 'transactionState'>;

/**
 * How a save is fenced. On its own it is a transaction; inside a transaction the user
 * opened, a savepoint, so a failure undoes only the save and the user's transaction
 * stays — a nested BEGIN would commit it in MySQL and be ignored in PostgreSQL.
 */
interface Fence {
  readonly begin: string;
  /** Absent where a savepoint is let go only with the transaction (SQL Server). */
  readonly commit: string | undefined;
  readonly rollback: string;
  readonly joined: boolean;
}

const SAVEPOINT = 'datanest_save';

function fenceOf(dialect: Dialect, joined: boolean): Fence {
  const words = dialect.transaction;
  return joined
    ? {
        begin: words.savepoint(SAVEPOINT),
        commit: words.releaseSavepoint?.(SAVEPOINT),
        rollback: words.rollbackToSavepoint(SAVEPOINT),
        joined,
      }
    : { begin: words.begin, commit: words.commit, rollback: words.rollback, joined };
}

export interface ResultSaverDeps {
  readonly manager: SaverConnections;
  readonly results: ResultStore;
  /** True while a query of this document is running, so its session is not free. */
  readonly isBusy: (documentUri: string) => boolean;
  /** How many rows to read back for a result. */
  readonly rowLimit: (summary: ResultSummary) => number;
  readonly logger: Logger;
}

interface Prepared {
  readonly summary: ResultSummary;
  readonly statements: ChangeStatement[];
  readonly dialect: Dialect;
}

function failure(code: string, message: string, statement?: string): SaveFailure {
  return { ok: false, code, message, ...(statement === undefined ? {} : { statement }) };
}

export class ResultSaver {
  private readonly deps: ResultSaverDeps;
  private readonly logger: Logger;
  private readonly saving = new Set<string>();

  constructor(deps: ResultSaverDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('save');
  }

  /** The statements a save would run, as text to read before committing to it. */
  async preview(resultId: string): Promise<PreviewOutcome> {
    const prepared = await this.prepare(resultId);
    if ('ok' in prepared) {
      return prepared;
    }
    const origin = prepared.summary.origin;
    const fence = fenceOf(
      prepared.dialect,
      origin !== undefined && this.deps.manager.transactionState(origin.owner) === 'open',
    );
    const lines = [
      `-- DataNest: pending changes of  ${oneLine(prepared.summary.statement)}`,
      `${fence.begin};`,
      ...prepared.statements.map((statement) => `${statement.sql};`),
      ...(fence.commit === undefined ? [] : [`${fence.commit};`]),
      '',
    ];
    return { ok: true, sql: lines.join('\n') };
  }

  async save(resultId: string): Promise<SaveOutcome> {
    if (this.saving.has(resultId)) {
      return failure('busy', 'These changes are already being saved');
    }
    this.saving.add(resultId);
    try {
      return await this.run(resultId);
    } finally {
      this.saving.delete(resultId);
    }
  }

  private async run(resultId: string): Promise<SaveOutcome> {
    const prepared = await this.prepare(resultId);
    if ('ok' in prepared) {
      return prepared;
    }
    const { summary, statements, dialect } = prepared;
    const origin = summary.origin;
    if (origin === undefined) {
      return failure('not-editable', 'This result cannot be saved');
    }
    let session: Session;
    try {
      session = await this.deps.manager.acquire(origin.owner, origin.target);
    } catch (error) {
      const dbError = toDbError(error);
      return failure(dbError.code, dbError.message);
    }

    const state = session.transactionState?.();
    if (state === 'failed') {
      return failure(
        'transaction-failed',
        'The open transaction of this editor failed; roll it back before saving',
      );
    }
    const fence = fenceOf(dialect, state === 'open');
    let current: string | undefined;
    try {
      await runStatement(session, fence.begin);
      for (const statement of statements) {
        current = statement.sql;
        const affected = await runStatement(session, statement.sql);
        if (statement.expectedRows !== undefined && affected !== statement.expectedRows) {
          await this.rollback(session, fence);
          return failure(
            'row-missing',
            affected === undefined || affected === 0
              ? 'A row was not found: it was changed or deleted since it was read. Nothing was saved.'
              : `A statement affected ${affected} rows instead of ${statement.expectedRows}. Nothing was saved.`,
            statement.sql,
          );
        }
      }
      if (fence.commit !== undefined) {
        current = fence.commit;
        await runStatement(session, fence.commit);
      }
    } catch (error) {
      await this.rollback(session, fence);
      const dbError = toDbError(error);
      this.logger.warn(`Saving failed: ${dbError.message}`, dbError);
      return failure(dbError.code, dbError.message, current);
    }

    this.logger.info(`Saved ${statements.length} change(s) of ${summary.id}`);
    const refreshed = await this.reload(summary, session);
    return {
      ok: true,
      statements: statements.length,
      refreshed,
      inTransaction: fence.joined,
    };
  }

  private async prepare(resultId: string): Promise<Prepared | SaveFailure> {
    const summary = this.deps.results.get(resultId);
    if (summary?.edit?.editable !== true || summary.origin === undefined) {
      return failure('not-editable', 'This result is read-only');
    }
    if (this.deps.isBusy(summary.documentUri)) {
      return failure('busy', 'A query is running in this editor; wait for it to finish');
    }
    const plan = this.deps.results.pendingPlan(resultId);
    if (plan === undefined) {
      return failure('not-editable', 'This result is no longer available');
    }
    try {
      const driver = await this.deps.manager.driverOf(summary.origin.target.connectionId);
      const statements = buildChangeStatements({ edit: summary.edit, ...plan }, driver.dialect);
      if (statements.length === 0) {
        return failure('no-changes', 'There are no changes to save');
      }
      return { summary, statements, dialect: driver.dialect };
    } catch (error) {
      const dbError = toDbError(error);
      return failure(dbError.code, dbError.message);
    }
  }

  private async rollback(session: Session, fence: Fence): Promise<void> {
    try {
      await runStatement(session, fence.rollback);
    } catch (error) {
      // The connection may be gone already, which rolls the transaction back itself.
      this.logger.warn(`Rollback failed: ${errorMessage(error)}`);
    }
  }

  /** Reads the rows again so generated keys and server-side values show up. */
  private async reload(summary: ResultSummary, session: Session): Promise<boolean> {
    try {
      const rowLimit = Math.max(1, Math.trunc(this.deps.rowLimit(summary)));
      let columns: readonly ResultColumn[] = [];
      const rows: ResultRow[] = [];
      let truncated = false;
      for await (const event of session.execute(summary.statement, { rowLimit })) {
        if (event.kind === 'columns') {
          columns = event.columns;
        } else if (event.kind === 'rows') {
          for (const row of event.rows) {
            if (rows.length >= rowLimit) {
              truncated = true;
              break;
            }
            rows.push(row);
          }
        }
      }
      return this.deps.results.replaceRows(summary.id, columns, rows, truncated);
    } catch (error) {
      this.logger.warn(`Saved, but could not re-read the rows: ${errorMessage(error)}`);
      // The changes are in the database, so the queue must not offer them again.
      this.deps.results.discardPending(summary.id);
      return false;
    }
  }
}

/** Runs one statement to its end and reports the rows it affected. */
async function runStatement(session: Session, sql: string): Promise<number | undefined> {
  let affected: number | undefined;
  for await (const event of session.execute(sql)) {
    if (event.kind === 'done') {
      affected = event.affectedRows;
    }
  }
  return affected;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

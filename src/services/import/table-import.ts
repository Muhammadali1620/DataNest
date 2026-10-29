// Fills a table from the records of a file (V5.3), in batches, on a session of its
// own. Either all of it in one transaction — the first bad row undoes everything —
// or row by row as far as it goes, keeping a list of the rows that did not fit.

import { DbError, errorMessage, toDbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { TableRef } from '../../core/model/objects';
import type { Session } from '../../drivers/driver';
import { ConnectionManager, type SessionTarget } from '../connection-manager';
import { RowBatcher } from '../dump-script';
import { exactLiteralOf } from '../sql-literal';
import type { SourceRecord } from './import-source';
import { convertValue, type ImportProblem, type ValueOptions } from './import-values';

export type ImportMode = 'all' | 'skip';

/** A table column that receives values, and where in a record they come from. */
export interface ImportColumn {
  readonly name: string;
  readonly dataType: string;
  /** Index of the field in a source record. */
  readonly source: number;
  /** An identity or auto-increment column: explicit values need saying so (PostgreSQL). */
  readonly autoIncrement: boolean;
  /** Draws from a sequence that must move past the imported values afterwards. */
  readonly sequenced: boolean;
}

export interface ImportRequest {
  readonly target: SessionTarget;
  readonly table: TableRef;
  readonly columns: readonly ImportColumn[];
  readonly records: AsyncIterable<SourceRecord>;
  readonly values: ValueOptions;
  readonly mode: ImportMode;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImportProgress) => void;
}

export interface ImportProgress {
  readonly read: number;
  readonly inserted: number;
  readonly failed: number;
}

export interface ImportFailure {
  /** Line of the file where the record starts; a batch names its first and last. */
  readonly line: number;
  readonly lastLine?: number;
  /** The column whose value did not fit, when that is what went wrong. */
  readonly column?: string;
  readonly problem?: ImportProblem;
  /** The server's or the reader's message. */
  readonly message?: string;
}

export interface ImportReport {
  readonly outcome: 'done' | 'stopped' | 'cancelled';
  readonly read: number;
  readonly inserted: number;
  readonly failedCount: number;
  readonly failures: readonly ImportFailure[];
  /** In `all` mode nothing was kept: the transaction was rolled back. */
  readonly rolledBack: boolean;
  readonly durationMs: number;
}

export const MAX_IMPORT_FAILURES = 1000;

export interface TableImporterDeps {
  readonly manager: Pick<ConnectionManager, 'acquire' | 'release' | 'driverOf'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

interface PendingRow {
  readonly line: number;
  readonly tuple: string;
}

let nextImport = 1;

export class TableImporter {
  private readonly manager: TableImporterDeps['manager'];
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: TableImporterDeps) {
    this.manager = deps.manager;
    this.logger = deps.logger.child('import');
    this.now = deps.now ?? Date.now;
  }

  async run(request: ImportRequest): Promise<ImportReport> {
    const started = this.now();
    if (request.columns.length === 0) {
      throw new DbError('unsupported', 'No column of the table gets a value from the file');
    }
    const { dialect } = await this.manager.driverOf(request.target.connectionId);
    const owner = ConnectionManager.taskOwner(`import-${nextImport++}`);
    const session = await this.manager.acquire(owner, request.target);
    const state = new ImportState();
    const quotedTable = dialect.quoteTable(request.table);
    const quotedColumns = request.columns.map((column) => dialect.quoteIdentifier(column.name));
    const identity = request.columns.some((column) => column.autoIncrement);
    const insert = (rows: readonly PendingRow[]): string =>
      dialect.dump.insert(
        quotedTable,
        quotedColumns,
        rows.map((row) => row.tuple),
        identity,
      );
    const all = request.mode === 'all';
    const cancel = (): void => {
      session.cancel().catch((error: unknown) => {
        this.logger.warn('Cancelling the import statement failed', error);
      });
    };
    request.signal?.addEventListener('abort', cancel);
    let rolledBack = false;
    try {
      if (all) {
        await run(session, dialect.transaction.begin);
      }
      const flush = async (rows: readonly PendingRow[]): Promise<boolean> =>
        await this.insertRows(session, rows, insert, request.mode, state);
      const batcher = new Batcher();
      for await (const record of request.records) {
        if (request.signal?.aborted === true) {
          state.outcome = 'cancelled';
          break;
        }
        state.read += 1;
        const row = this.rowOf(record, request, dialect, state);
        if (row === undefined) {
          if (all) {
            state.outcome = 'stopped';
            break;
          }
          continue;
        }
        const full = batcher.add(row);
        if (full !== undefined && !(await flush(full))) {
          break;
        }
        request.onProgress?.(state.progress());
      }
      if (state.outcome === 'done') {
        // A failure here is in the report already, with the outcome set.
        await flush(batcher.take());
      }
      if (aborted(request.signal)) {
        state.outcome = 'cancelled';
      }
      if (all) {
        if (state.outcome === 'done') {
          await run(session, dialect.transaction.commit);
        } else {
          // Should ROLLBACK itself fail, closing the session below undoes the same.
          await run(session, dialect.transaction.rollback).catch((error: unknown) => {
            this.logger.warn('ROLLBACK after a stopped import failed', error);
          });
          rolledBack = true;
        }
      }
      if (state.inserted > 0 && !rolledBack) {
        await this.moveSequences(session, request, state);
      }
    } catch (error) {
      if (all) {
        await run(session, dialect.transaction.rollback).catch(() => undefined);
      }
      if (aborted(request.signal)) {
        throw new DbError('cancelled', 'The import was cancelled');
      }
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', cancel);
      await this.manager.release(owner);
    }
    request.onProgress?.(state.progress());
    const report: ImportReport = {
      outcome: state.outcome,
      read: state.read,
      inserted: rolledBack ? 0 : state.inserted,
      failedCount: state.failedCount,
      failures: state.failures,
      rolledBack,
      durationMs: this.now() - started,
    };
    this.logger.info(
      `Import ${report.outcome}: ${report.inserted} rows in, ${report.failedCount} failed`,
    );
    return report;
  }

  /** The record as a `(…)` list, or undefined (with the failure noted) when it does not fit. */
  private rowOf(
    record: SourceRecord,
    request: ImportRequest,
    dialect: Parameters<typeof exactLiteralOf>[0],
    state: ImportState,
  ): PendingRow | undefined {
    if ('error' in record) {
      state.fail({ line: record.line, message: record.error });
      return undefined;
    }
    const literals: string[] = [];
    for (const column of request.columns) {
      const converted = convertValue(record.values[column.source], column.dataType, request.values);
      if (!converted.ok) {
        state.fail({ line: record.line, column: column.name, problem: converted.problem });
        return undefined;
      }
      try {
        literals.push(exactLiteralOf(dialect, converted.value));
      } catch (error) {
        state.fail({ line: record.line, column: column.name, message: errorMessage(error) });
        return undefined;
      }
    }
    return { line: record.line, tuple: `(${literals.join(', ')})` };
  }

  /**
   * One INSERT for the batch. When it fails in `skip` mode, the rows go one at a time
   * so only the bad ones are left out. False when the import must stop.
   */
  private async insertRows(
    session: Session,
    rows: readonly PendingRow[],
    insert: (rows: readonly PendingRow[]) => string,
    mode: ImportMode,
    state: ImportState,
  ): Promise<boolean> {
    if (rows.length === 0) {
      return true;
    }
    try {
      await run(session, insert(rows));
      state.inserted += rows.length;
      return true;
    } catch (error) {
      const dbError = toDbError(error);
      if (mode === 'all' || dbError.code === 'connection-failed' || dbError.code === 'cancelled') {
        const first = rows[0]?.line ?? 0;
        const last = rows[rows.length - 1]?.line ?? first;
        state.fail({
          line: first,
          ...(last === first ? {} : { lastLine: last }),
          message: errorMessage(dbError),
        });
        state.outcome = dbError.code === 'cancelled' ? 'cancelled' : 'stopped';
        return false;
      }
    }
    for (const row of rows) {
      try {
        await run(session, insert([row]));
        state.inserted += 1;
      } catch (error) {
        const dbError = toDbError(error);
        state.fail({ line: row.line, message: errorMessage(dbError) });
        if (dbError.code === 'connection-failed' || dbError.code === 'cancelled') {
          state.outcome = dbError.code === 'cancelled' ? 'cancelled' : 'stopped';
          return false;
        }
      }
    }
    return true;
  }

  /** Explicit ids leave a sequence behind them; it is moved past the highest one. */
  private async moveSequences(
    session: Session,
    request: ImportRequest,
    state: ImportState,
  ): Promise<void> {
    const { dialect } = await this.manager.driverOf(request.target.connectionId);
    const reset = dialect.dump.resetSequence;
    if (reset === undefined) {
      return;
    }
    for (const column of request.columns.filter((candidate) => candidate.sequenced)) {
      try {
        await run(session, reset(request.table, column.name));
      } catch (error) {
        this.logger.warn(`Moving the sequence of ${column.name} failed`, error);
        state.fail({ line: 0, column: column.name, message: errorMessage(error) });
      }
    }
  }
}

class ImportState {
  outcome: ImportReport['outcome'] = 'done';
  read = 0;
  inserted = 0;
  failedCount = 0;
  readonly failures: ImportFailure[] = [];

  fail(failure: ImportFailure): void {
    this.failedCount += 1;
    if (this.failures.length < MAX_IMPORT_FAILURES) {
      this.failures.push(failure);
    }
  }

  progress(): ImportProgress {
    return { read: this.read, inserted: this.inserted, failed: this.failedCount };
  }
}

/** Rows wait here until there are enough for one INSERT. */
class Batcher {
  private readonly rows = new RowBatcher();
  private pending: PendingRow[] = [];

  add(row: PendingRow): PendingRow[] | undefined {
    this.pending.push(row);
    return this.rows.add(row.tuple) === undefined ? undefined : this.take();
  }

  take(): PendingRow[] {
    this.rows.take();
    const rows = this.pending;
    this.pending = [];
    return rows;
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function run(session: Session, sql: string): Promise<void> {
  for await (const _event of session.execute(sql)) {
    // An INSERT returns nothing worth reading.
  }
}

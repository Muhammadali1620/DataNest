// A session on a SQLite file that lives on a server, which may also change it (V13.33).
// Reading is as before (V12.8): a copy of the file made over SFTP, opened by the SQLite driver.
// Whatever changes the file is not run on the copy but sent to the server, where a helper
// (remote-sqlite-writer.ts) runs it against the real file. The copy is then out of date, and
// the next read makes a new one: no file is ever sent back, so nothing another program
// wrote in the meantime is overwritten.
//
// The helper keeps one connection to the file for the life of the session, so a transaction
// spans statements. Inside one, reads still come from the copy, which does not show the
// changes of the open transaction until it ends.

import { DbError } from '../core/errors';
import { msg } from '../core/user-message';
import { isReadOnlyStatement } from '../core/sql/read-only';
import { transactionControl } from '../core/sql/transaction-control';
import { syntaxOf } from '../core/sql/tokenizer';
import type {
  ExecuteEvent,
  ExecuteOptions,
  MetadataReader,
  Session,
  TransactionState,
} from '../drivers/driver';
import type { SnapshotLease } from './remote-snapshots';
import type { RemoteSqliteWriter } from './remote-sqlite-writer';

export interface RemoteSqliteDeps {
  /** Opens the SQLite driver's session over a copy of the file. */
  openLocal(path: string): Promise<Session>;
  /** The newest copy of the file (a new one when the last was invalidated). */
  acquireCopy(): Promise<SnapshotLease>;
  /** Counts the times the copy was declared out of date. */
  generation(): number;
  /** Declares the copy out of date: the file on the server changed. */
  invalidate(): void;
  /** Starts the helper on the server and opens the file for writing there. */
  openWriter(): Promise<RemoteSqliteWriter>;
}

/** True for a statement that must run on the server: it changes the file or the transaction. */
export function runsOnServer(sql: string): boolean {
  return (
    transactionControl(sql, 'sqlite') !== 'none' || !isReadOnlyStatement(sql, syntaxOf('sqlite'))
  );
}

export class RemoteWritableSession implements Session {
  readonly metadata: MetadataReader;
  private local: Session;
  private lease: SnapshotLease;
  /** The generation of the copy `local` was opened on. */
  private generation: number;
  private writer: RemoteSqliteWriter | undefined;
  private opening: Promise<RemoteSqliteWriter> | undefined;
  private renewing: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly deps: RemoteSqliteDeps,
    first: { readonly local: Session; readonly lease: SnapshotLease; readonly generation: number },
  ) {
    this.local = first.local;
    this.lease = first.lease;
    this.generation = first.generation;
    this.metadata = this.currentMetadata();
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  transactionState(): TransactionState {
    return this.writer?.inTransaction === true ? 'open' : 'idle';
  }

  async cancel(): Promise<void> {
    if (this.writer !== undefined) {
      // The helper is busy inside SQLite: only dropping the link stops it. The server then
      // undoes what is not committed, and the next change starts a helper again.
      this.writer.abort();
    }
    await this.local.cancel();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const writer = this.writer ?? (await this.opening?.catch(() => undefined));
    this.writer = undefined;
    await writer?.close().catch(() => undefined);
    await this.local.close().catch(() => undefined);
    await this.lease.release();
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    if (runsOnServer(sql)) {
      yield* this.runOnServer(sql);
      return;
    }
    await this.renewCopy();
    yield* this.local.execute(sql, options);
  }

  private async *runOnServer(sql: string): AsyncGenerator<ExecuteEvent> {
    const writer = await this.helper();
    const control = transactionControl(sql, 'sqlite');
    const wasOpen = writer.inTransaction;
    let outcome;
    try {
      outcome = await writer.run(sql);
    } catch (error) {
      if (!writer.alive) {
        this.writer = undefined;
      }
      // A statement that failed may still have ended a transaction (a failed COMMIT does
      // not; a lost link does), and a lost link may have lost a commit: look again.
      if (!writer.alive) {
        this.deps.invalidate();
      }
      throw error;
    }
    // The file on the server changed unless the statement only began or rolled back, or the
    // change waits in a transaction that is still open.
    const changed =
      !outcome.inTransaction &&
      control !== 'begin' &&
      control !== 'rollback' &&
      (wasOpen || control === 'none' || control === 'commit');
    if (changed) {
      this.deps.invalidate();
    }
    if (outcome.columns !== undefined) {
      yield { kind: 'columns', columns: outcome.columns };
      if (outcome.rows !== undefined && outcome.rows.length > 0) {
        yield { kind: 'rows', rows: outcome.rows };
      }
    }
    yield outcome.affectedRows === undefined
      ? { kind: 'done' }
      : { kind: 'done', affectedRows: outcome.affectedRows };
  }

  /** The helper of this session, started at the first change. */
  private async helper(): Promise<RemoteSqliteWriter> {
    if (this.writer?.alive === true) {
      return this.writer;
    }
    this.writer = undefined;
    this.opening ??= this.deps.openWriter().finally(() => {
      this.opening = undefined;
    });
    const writer = await this.opening;
    this.writer = writer;
    return writer;
  }

  /** Reopens the copy when the file was changed on the server since it was made. */
  private async renewCopy(): Promise<void> {
    if (this.deps.generation() === this.generation) {
      return;
    }
    this.renewing ??= this.renew().finally(() => {
      this.renewing = undefined;
    });
    await this.renewing;
  }

  private async renew(): Promise<void> {
    const generation = this.deps.generation();
    const lease = await this.deps.acquireCopy();
    let local: Session;
    try {
      local = await this.deps.openLocal(lease.path);
    } catch (error) {
      await lease.release();
      throw error;
    }
    const oldLocal = this.local;
    const oldLease = this.lease;
    this.local = local;
    this.lease = lease;
    this.generation = generation;
    await oldLocal.close().catch(() => undefined);
    await oldLease.release();
  }

  /**
   * The reader of the tree: each call looks at the newest copy first. A method the driver's
   * reader does not have stays absent, so callers that test for it still can.
   */
  private currentMetadata(): MetadataReader {
    const methods = (): Record<string, unknown> =>
      this.local.metadata as unknown as Record<string, unknown>;
    return new Proxy({} as MetadataReader, {
      get: (_target, name) => {
        if (typeof name !== 'string' || typeof methods()[name] !== 'function') {
          return undefined;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          await this.renewCopy();
          const method = methods()[name] as (...inner: unknown[]) => Promise<unknown>;
          return await method.apply(this.local.metadata, args);
        };
      },
    });
  }
}

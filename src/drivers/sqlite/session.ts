import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AsyncQueue } from '../../core/async-queue';
import { DbError } from '../../core/errors';
import type { ResolvedConnectionConfig } from '../../core/model/connection';
import type { CellValue } from '../../shared/cell-value';
import type { ExecuteEvent, ExecuteOptions, Session } from '../driver';
import { fromWireError, toSqliteDbError } from './errors';
import { SqliteMetadata } from './metadata';
import type { SqliteParam, WorkerToHost } from './protocol';

/** The worker bundle next to dist/drivers/sqlite.js (scripts/build-config.mjs). */
export const WORKER_FILENAME = 'sqlite-worker.js';

export interface SqliteSessionOptions {
  /** Overrides the worker bundle path (tests build it on the fly). */
  readonly workerPath?: string;
}

export async function openSqliteSession(
  config: ResolvedConnectionConfig,
  options: SqliteSessionOptions = {},
): Promise<Session> {
  const file = config.file;
  if (file === undefined || file === '') {
    throw new DbError('unsupported', 'A SQLite connection needs a database file path');
  }
  const session = new SqliteSession(options.workerPath ?? defaultWorkerPath(), file);
  await session.open();
  return session;
}

function defaultWorkerPath(): string {
  // __dirname exists only in the bundled CJS output; tests pass workerPath instead.
  if (typeof __dirname === 'undefined') {
    throw new DbError('internal', 'The SQLite worker bundle location is unknown');
  }
  return join(__dirname, WORKER_FILENAME);
}

class SqliteSession implements Session {
  readonly metadata: SqliteMetadata;
  private readonly workerPath: string;
  private readonly file: string;
  private readonly queues = new Map<number, AsyncQueue<ExecuteEvent>>();
  private ready: Promise<Worker>;
  private nextId = 1;
  private closed = false;
  private cancelling: Promise<void> | undefined;
  /** Incremented on every (re)spawn; events of an older worker are ignored. */
  private generation = 0;

  constructor(workerPath: string, file: string) {
    this.workerPath = workerPath;
    this.file = file;
    this.metadata = new SqliteMetadata(this);
    this.ready = Promise.reject(new DbError('internal', 'The session is not open yet'));
    this.ready.catch(() => undefined);
  }

  async open(): Promise<void> {
    this.ready = this.track(this.spawn());
    await this.ready;
  }

  /**
   * Keeps a stored `ready` promise from counting as an unhandled rejection when
   * no statement is waiting on it; every caller still sees the error it carries.
   */
  private track(ready: Promise<Worker>): Promise<Worker> {
    ready.catch(() => undefined);
    return ready;
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /** Rows of a parameterized query; used by metadata lookups. */
  async queryRows(sql: string, params: readonly SqliteParam[]): Promise<CellValue[][]> {
    const rows: CellValue[][] = [];
    for await (const event of this.run(sql, {}, params)) {
      if (event.kind === 'rows') {
        rows.push(...event.rows.map((row) => [...row]));
      }
    }
    return rows;
  }

  private async *run(
    sql: string,
    options: ExecuteOptions,
    params?: readonly SqliteParam[],
  ): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', 'The session is closed');
    }
    const worker = await this.ready;
    const id = this.nextId++;
    const queue = new AsyncQueue<ExecuteEvent>();
    this.queues.set(id, queue);
    try {
      worker.postMessage({
        t: 'exec',
        id,
        sql,
        ...(params === undefined ? {} : { params }),
        ...(options.rowLimit === undefined ? {} : { rowLimit: options.rowLimit }),
      });
      for await (const event of queue) {
        yield event;
      }
    } finally {
      // An abandoned statement needs no kill: the worker finishes it and the
      // closed queue silently drops the rest.
      this.queues.delete(id);
    }
  }

  /**
   * node:sqlite has no interrupt, and `terminate()` cannot preempt a synchronous
   * native call: V8 only stops the thread once SQLite returns from the statement.
   * So cancel abandons the worker — terminate is requested but not awaited — and
   * brings up a fresh one over the same file. The user regains control at once;
   * the abandoned thread exits on its own, and its events are ignored from here on.
   * This is safe because SQLite is crash-safe and every statement is its own
   * transaction unless the user opened one explicitly.
   */
  async cancel(): Promise<void> {
    if (this.closed || this.queues.size === 0) {
      return;
    }
    this.cancelling ??= this.restart().finally(() => {
      this.cancelling = undefined;
    });
    await this.cancelling;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.generation += 1;
    this.failAll(new DbError('cancelled', 'The session was closed'));
    const worker = await this.ready.catch(() => undefined);
    // Not awaited for the same reason as in cancel(): a worker busy inside SQLite
    // stops only when the statement returns, and closing must not block on that.
    void worker?.terminate();
  }

  private async restart(): Promise<void> {
    const previous = await this.ready.catch(() => undefined);
    // Bump first: everything the abandoned worker still sends is now stale.
    this.generation += 1;
    void previous?.terminate();
    this.failAll(new DbError('cancelled', 'The statement was cancelled'));
    this.ready = this.track(this.spawn());
    await this.ready;
  }

  private spawn(): Promise<Worker> {
    const generation = (this.generation += 1);
    return new Promise<Worker>((resolve, reject) => {
      let settled = false as boolean;
      let worker: Worker;
      try {
        worker = new Worker(this.workerPath);
      } catch (error) {
        reject(toSqliteDbError(error));
        return;
      }
      const isCurrent = (): boolean => this.generation === generation;
      worker.on('message', (raw: WorkerToHost) => {
        if (raw.t === 'opened') {
          settled = true;
          resolve(worker);
          return;
        }
        if (raw.t === 'open-error') {
          settled = true;
          void worker.terminate();
          reject(fromWireError(raw.error));
          return;
        }
        if (isCurrent()) {
          this.dispatch(raw);
        }
      });
      worker.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(toSqliteDbError(error));
          return;
        }
        if (isCurrent()) {
          this.failAll(toSqliteDbError(error));
        }
      });
      worker.on('exit', () => {
        if (!settled) {
          settled = true;
          reject(new DbError('internal', 'The SQLite worker exited during start'));
          return;
        }
        // An abandoned worker (cancel, close) is expected to exit; only the
        // worker still in charge means a crash the running statements must see.
        if (isCurrent() && !this.closed) {
          this.failAll(new DbError('internal', 'The SQLite worker stopped unexpectedly'));
        }
      });
      worker.postMessage({ t: 'open', file: this.file });
    });
  }

  private dispatch(message: WorkerToHost): void {
    if (message.t === 'opened' || message.t === 'open-error') {
      return;
    }
    const queue = this.queues.get(message.id);
    if (!queue) {
      return;
    }
    switch (message.t) {
      case 'columns':
        queue.push({ kind: 'columns', columns: message.columns });
        return;
      case 'rows':
        queue.push({ kind: 'rows', rows: message.rows });
        return;
      case 'done':
        queue.push(
          message.affectedRows === undefined
            ? { kind: 'done' }
            : { kind: 'done', affectedRows: message.affectedRows },
        );
        queue.end();
        this.queues.delete(message.id);
        return;
      case 'error':
        queue.fail(fromWireError(message.error));
        this.queues.delete(message.id);
        return;
    }
  }

  private failAll(error: DbError): void {
    for (const queue of this.queues.values()) {
      queue.fail(error);
    }
    this.queues.clear();
  }
}

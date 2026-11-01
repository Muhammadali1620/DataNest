import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import { tlsFailure, tlsMaterial } from '../common/tls';
import type {
  ExecuteEvent,
  ExecuteOptions,
  ResultColumn,
  Session,
  TransactionState,
} from '../driver';
import { SqliteMetadata } from '../sqlite/metadata';
import { fromHranaError, toLibsqlDbError } from './errors';
import {
  type HranaExecuteResult,
  type HranaOutcome,
  HranaStream,
  StreamExpired,
  targetUrl,
} from './hrana';
import { fromHranaValue, type LibsqlParam, toHranaValue } from './values';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** What one statement came back with. */
interface Answer {
  readonly result: HranaExecuteResult;
}

export async function openLibsqlSession(config: ResolvedConnectionConfig): Promise<Session> {
  const tls = await tlsMaterial(config);
  const url = targetUrl(config.host, config.port, tls !== undefined);
  const token =
    config.password === undefined || config.password === '' ? undefined : config.password;
  const stream = new HranaStream(
    { url, ...(token === undefined ? {} : { token }), tls },
    config.readOnly === true,
  );
  const session = new LibsqlSession(stream);
  try {
    await session.check((config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000);
  } catch (error) {
    await stream.close();
    throw tlsFailure(error, tls?.serverName ?? '') ?? toLibsqlDbError(error);
  }
  return session;
}

function isResult(value: unknown): value is HranaExecuteResult {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { cols?: unknown }).cols)
  );
}

class LibsqlSession implements Session {
  readonly metadata: SqliteMetadata;
  /** Requests of one stream cannot overlap: each waits for the one before it. */
  private tail: Promise<void> = Promise.resolve();
  private inTransaction = false;
  private current: AbortController | undefined;
  private closed = false;

  constructor(private readonly stream: HranaStream) {
    this.metadata = new SqliteMetadata(this);
  }

  /** The first request: proves the address, the token and (when read-only) the pragma. */
  async check(timeoutMs: number): Promise<void> {
    await this.exclusive(async () => {
      const outcomes = await this.stream.send(
        [{ type: 'execute', stmt: { sql: 'SELECT 1', want_rows: false } }],
        AbortSignal.timeout(timeoutMs),
      );
      const first = outcomes[0];
      if (first?.type === 'error') {
        throw fromHranaError(first.error);
      }
    });
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options, undefined);
  }

  transactionState(): TransactionState | undefined {
    return this.stream.reportsTransactions ? (this.inTransaction ? 'open' : 'idle') : undefined;
  }

  /** Rows of a parameterized query; used by metadata lookups. */
  async queryRows(sql: string, params: readonly LibsqlParam[]): Promise<CellValue[][]> {
    const rows: CellValue[][] = [];
    for await (const event of this.run(sql, {}, params)) {
      if (event.kind === 'rows') {
        rows.push(...event.rows.map((row) => [...row]));
      }
    }
    return rows;
  }

  /**
   * Abandons the statement in flight: its request is aborted, and the stream with it. An
   * open transaction goes with the stream (the server rolls it back when it expires).
   */
  cancel(): Promise<void> {
    this.current?.abort();
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.current?.abort();
    await this.tail.catch(() => undefined);
    await this.stream.close();
  }

  private async *run(
    sql: string,
    options: ExecuteOptions,
    params: readonly LibsqlParam[] | undefined,
  ): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const release = await this.acquire();
    try {
      const { result } = await this.statement(sql, params);
      const columns: ResultColumn[] = result.cols.map((column, index) => {
        const name = column.name ?? `column${index + 1}`;
        return typeof column.decltype === 'string' && column.decltype !== ''
          ? { name, dataType: column.decltype.toLowerCase() }
          : { name };
      });
      if (columns.length === 0) {
        yield { kind: 'done', affectedRows: result.affected_row_count };
        return;
      }
      yield { kind: 'columns', columns };
      const limit = options.rowLimit ?? Number.POSITIVE_INFINITY;
      const total = Math.min(result.rows.length, limit);
      for (let start = 0; start < total; start += ROW_BATCH_SIZE) {
        const slice = result.rows.slice(start, Math.min(start + ROW_BATCH_SIZE, total));
        yield {
          kind: 'rows',
          rows: slice.map((row) => row.map((cell) => fromHranaValue(cell))),
        };
      }
      yield { kind: 'done' };
    } finally {
      release();
    }
  }

  /** Sends one statement with the question whether a transaction is open after it. */
  private async statement(
    sql: string,
    params: readonly LibsqlParam[] | undefined,
  ): Promise<Answer> {
    const request = {
      type: 'execute' as const,
      stmt: {
        sql,
        want_rows: true,
        ...(params === undefined ? {} : { args: params.map(toHranaValue) }),
      },
    };
    const controller = new AbortController();
    this.current = controller;
    try {
      let outcomes: (HranaOutcome | undefined)[];
      try {
        outcomes = await this.stream.send([request, { type: 'get_autocommit' }], controller.signal);
      } catch (error) {
        if (error instanceof StreamExpired) {
          outcomes = await this.afterExpiry(request);
        } else {
          if (controller.signal.aborted) {
            this.inTransaction = false;
            throw new DbError('cancelled', msg('The statement was cancelled'));
          }
          throw error;
        }
      }
      const executed = outcomes[0];
      const commit = outcomes[1];
      if (commit?.type === 'ok' && typeof commit.response.is_autocommit === 'boolean') {
        this.inTransaction = !commit.response.is_autocommit;
      }
      if (executed === undefined) {
        throw new DbError('internal', msg('The server sent no answer to the statement'));
      }
      if (executed.type === 'error') {
        await this.refreshTransaction();
        throw fromHranaError(executed.error);
      }
      const result = executed.response.result;
      if (!isResult(result)) {
        throw new DbError(
          'internal',
          msg('The server sent an answer to the statement in an unknown form'),
        );
      }
      return { result };
    } finally {
      this.current = undefined;
    }
  }

  /** A stream the server dropped: an idle session starts a new one, a transaction is lost. */
  private async afterExpiry(
    request: Parameters<HranaStream['send']>[0][number],
  ): Promise<(HranaOutcome | undefined)[]> {
    if (this.inTransaction) {
      this.inTransaction = false;
      throw new DbError(
        'connection-failed',
        msg('The server closed the session; the open transaction was lost'),
      );
    }
    return await this.stream.send([request, { type: 'get_autocommit' }]);
  }

  /** After a failed statement a transaction may still be open (SQLite keeps it). */
  private async refreshTransaction(): Promise<void> {
    if (!this.stream.reportsTransactions) {
      return;
    }
    try {
      const [answer] = await this.stream.send([{ type: 'get_autocommit' }]);
      if (answer?.type === 'ok' && typeof answer.response.is_autocommit === 'boolean') {
        this.inTransaction = !answer.response.is_autocommit;
      }
    } catch {
      // The error of the statement is the one to show.
    }
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Waits for the statements before this one; the returned function lets the next go. */
  private async acquire(): Promise<() => void> {
    const before = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    return release;
  }
}

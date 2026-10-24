import * as mysql from 'mysql2';
import { AsyncQueue } from '../../core/async-queue';
import { DbError } from '../../core/errors';
import { effectivePort, type ResolvedConnectionConfig } from '../../core/model/connection';
import type { CellValue } from '../../shared/cell-value';
import type { ExecuteEvent, ExecuteOptions, ResultColumn, Session } from '../driver';
import { toMysqlDbError } from './errors';
import { MysqlMetadata } from './metadata';
import { mysqlTypeName, toCellValue } from './values';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

export const CONNECT_TIMEOUT_MS = 10_000;

const QUERY_INTERRUPTED = 1317; // ER_QUERY_INTERRUPTED

function connectionOptions(config: ResolvedConnectionConfig): mysql.ConnectionOptions {
  return {
    host: config.host,
    port: effectivePort(config),
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    charset: 'utf8mb4',
    // Values that cannot survive a JS number arrive as text (ARCHITECTURE.md §5):
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
  };
}

export async function openMysqlSession(config: ResolvedConnectionConfig): Promise<Session> {
  const raw = mysql.createConnection(connectionOptions(config));
  // Fatal errors between queries (e.g. a dropped socket) must not crash the host;
  // the next statement surfaces them as a normal failure.
  raw.on('error', () => undefined);
  try {
    await raw.promise().connect();
  } catch (error) {
    raw.destroy();
    throw toMysqlDbError(error);
  }
  return new MysqlSession(raw, config);
}

/** The slice of a field packet the driver reads. */
interface FieldLike {
  readonly name?: string;
  readonly type?: number;
  readonly columnType?: number;
}

class MysqlSession implements Session {
  readonly metadata: MysqlMetadata;
  private readonly conn: mysql.Connection;
  private readonly config: ResolvedConnectionConfig;
  private cancelling: Promise<void> | undefined;
  private closed = false;
  /** Identity of the statement currently on the wire; undefined between statements. */
  private active: object | undefined;

  constructor(conn: mysql.Connection, config: ResolvedConnectionConfig) {
    this.conn = conn;
    this.config = config;
    this.metadata = new MysqlMetadata(conn.promise());
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', 'The session is closed');
    }
    const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    const queue = new AsyncQueue<ExecuteEvent>();
    let fieldTypes: (number | undefined)[] = [];
    let batch: CellValue[][] = [];
    let rowCount = 0;
    let limitHit = false as boolean;
    let affectedRows: number | undefined;
    let settled = false as boolean;

    const flush = (): void => {
      if (batch.length > 0) {
        queue.push({ kind: 'rows', rows: batch });
        batch = [];
      }
    };
    const finish = (): void => {
      settled = true;
      flush();
      queue.push(affectedRows === undefined ? { kind: 'done' } : { kind: 'done', affectedRows });
      queue.end();
    };

    const command = this.conn.query({ sql, rowsAsArray: true });
    const token = {};
    this.active = token;
    const release = (): void => {
      if (this.active === token) {
        this.active = undefined;
      }
    };
    command.on('fields', (fields: FieldLike | FieldLike[] | undefined) => {
      const list = Array.isArray(fields) ? fields : fields === undefined ? [] : [fields];
      if (list.length === 0) {
        return;
      }
      flush();
      fieldTypes = list.map((field) => field.columnType ?? field.type);
      const columns: ResultColumn[] = list.map((field, index) => {
        const dataType = mysqlTypeName(fieldTypes[index]);
        return dataType === undefined
          ? { name: field.name ?? `column${index + 1}` }
          : { name: field.name ?? `column${index + 1}`, dataType };
      });
      queue.push({ kind: 'columns', columns });
    });
    command.on('result', (row: unknown) => {
      if (!Array.isArray(row)) {
        // An OK packet: INSERT/UPDATE/DDL or the tail of a multi-set CALL.
        const header = row as { affectedRows?: number };
        if (typeof header.affectedRows === 'number') {
          affectedRows = header.affectedRows;
        }
        return;
      }
      if (rowCount >= rowLimit) {
        if (!limitHit) {
          limitHit = true;
          // Stop the server from producing rows nobody will see.
          void this.cancel(token);
        }
        return;
      }
      rowCount += 1;
      batch.push(row.map((value: unknown, index) => toCellValue(value, fieldTypes[index])));
      if (batch.length >= ROW_BATCH_SIZE) {
        flush();
      }
    });
    command.on('error', (error: unknown) => {
      release();
      const dbError = toMysqlDbError(error);
      // The kill we issued ourselves after the row limit is a success, not an error.
      if (limitHit && (dbError.code === 'cancelled' || dbError.driverCode === QUERY_INTERRUPTED)) {
        finish();
        return;
      }
      settled = true;
      queue.fail(dbError);
    });
    command.on('end', () => {
      release();
      if (!settled) {
        finish();
      }
    });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      if (!settled) {
        // The consumer stopped early; free the server and drop the rest.
        void this.cancel(token);
      }
    }
  }

  /**
   * Kills the currently running statement from a short-lived control connection.
   * With a `token`, only the statement that asked is killed: when it has already
   * finished, the kill is skipped so it cannot hit whatever runs next.
   */
  async cancel(token?: object): Promise<void> {
    if (
      this.closed ||
      this.active === undefined ||
      (token !== undefined && this.active !== token)
    ) {
      return;
    }
    this.cancelling ??= this.kill(token ?? this.active).finally(() => {
      this.cancelling = undefined;
    });
    await this.cancelling;
  }

  private async kill(token: object): Promise<void> {
    const control = mysql
      .createConnection({ ...connectionOptions(this.config), database: undefined })
      .promise();
    try {
      await control.connect();
      // Re-check after the control connection is up: the statement may be done by now.
      if (this.active === token) {
        await control.query(`KILL QUERY ${this.conn.threadId}`);
      }
    } catch (error) {
      throw toMysqlDbError(error);
    } finally {
      await control.end().catch(() => {
        control.destroy();
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.conn.promise().end();
    } catch (_error) {
      // The socket may already be gone; closing must always succeed.
      this.conn.destroy();
    }
  }
}

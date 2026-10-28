import pg from 'pg';
import { AsyncQueue } from '../../core/async-queue';
import { DbError } from '../../core/errors';
import { effectivePort, type ResolvedConnectionConfig } from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import { identityCheck, sniName, tlsFailure, type TlsMaterial, tlsMaterial } from '../common/tls';
import type {
  ExecuteEvent,
  ExecuteOptions,
  ResultColumn,
  Session,
  TransactionState,
} from '../driver';
import { toPgDbError } from './errors';
import { PostgresMetadata } from './metadata';
import { pgTypeName, pgTypeParser, toCellValue } from './values';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

export const CONNECT_TIMEOUT_MS = 10_000;

const QUERY_CANCELLED = '57014';

/** Our parsers keep precision-critical values as text (ARCHITECTURE.md §5). */
const RAW_TYPES = { getTypeParser: pgTypeParser };

/** pg hands these to tls.connect; the name is checked against the real server. */
export function postgresSsl(tls: TlsMaterial): pg.ClientConfig['ssl'] {
  const servername = sniName(tls.serverName);
  return {
    ...(tls.ca === undefined ? {} : { ca: tls.ca }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    rejectUnauthorized: tls.mode !== 'require',
    ...(servername === undefined ? {} : { servername }),
    checkServerIdentity: identityCheck(tls),
  };
}

export function clientConfig(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): pg.ClientConfig {
  return {
    ...(tls === undefined ? {} : { ssl: postgresSsl(tls) }),
    host: config.host,
    port: effectivePort(config),
    user: config.user,
    password: config.password,
    // Unlike MySQL, a PostgreSQL session always needs a database; `postgres`
    // exists on practically every server and is the common default.
    database: config.database ?? 'postgres',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

export async function openPostgresSession(config: ResolvedConnectionConfig): Promise<Session> {
  const tls = await tlsMaterial(config);
  const client = new pg.Client(clientConfig(config, tls));
  try {
    await client.connect();
  } catch (error) {
    client.end().catch(() => undefined);
    throw tlsFailure(error, tls?.serverName ?? '') ?? toPgDbError(error);
  }
  // Fatal errors between queries (e.g. a dropped socket) must not crash the host;
  // the next statement surfaces them as a normal failure.
  client.on('error', () => undefined);
  if (config.readOnly === true) {
    try {
      // Every later transaction of the session is read-only; the server refuses writes.
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    } catch (error) {
      await client.end().catch(() => undefined);
      throw toPgDbError(error);
    }
  }
  return new PostgresSession(client, config, tls);
}

/** The slice of pg's field descriptors the driver reads. */
interface FieldLike {
  readonly name?: string;
  readonly dataTypeID?: number;
}

interface ResultLike {
  readonly fields?: readonly FieldLike[];
  readonly command?: string;
  readonly rowCount?: number | null;
}

const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'MOVE']);

class PostgresSession implements Session {
  readonly metadata: PostgresMetadata;
  private readonly client: pg.Client;
  private readonly config: ResolvedConnectionConfig;
  private readonly tls: TlsMaterial | undefined;
  private cancelling: Promise<void> | undefined;
  private closed = false;
  /** Identity of the statement currently on the wire; undefined between statements. */
  private active: object | undefined;
  /** The last statement failed; see transactionState(). */
  private lastFailed = false;

  constructor(client: pg.Client, config: ResolvedConnectionConfig, tls: TlsMaterial | undefined) {
    this.client = client;
    this.config = config;
    this.tls = tls;
    this.metadata = new PostgresMetadata(client);
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /**
   * From the status byte of the server's last "ready for query" message. An error
   * arrives just before that message; until it is read, an error inside a
   * transaction block means the block failed, which is what PostgreSQL does.
   */
  transactionState(): TransactionState {
    const client = this.client as unknown as {
      readonly readyForQuery?: boolean;
      getTransactionStatus?(): string | null;
    };
    let status = client.getTransactionStatus?.() ?? null;
    if (this.lastFailed && client.readyForQuery !== true && status === 'T') {
      status = 'E';
    }
    return status === 'T' ? 'open' : status === 'E' ? 'failed' : 'idle';
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', 'The session is closed');
    }
    const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    const queue = new AsyncQueue<ExecuteEvent>();
    let fieldOids: (number | undefined)[] = [];
    let columnsSent = false as boolean;
    let batch: CellValue[][] = [];
    let rowCount = 0;
    let limitHit = false as boolean;
    let affectedRows: number | undefined;
    let settled = false as boolean;

    const token = {};
    this.active = token;
    const release = (): void => {
      if (this.active === token) {
        this.active = undefined;
      }
    };
    const flush = (): void => {
      if (batch.length > 0) {
        queue.push({ kind: 'rows', rows: batch });
        batch = [];
      }
    };
    const sendColumns = (fields: readonly FieldLike[] | undefined): void => {
      if (columnsSent || fields === undefined || fields.length === 0) {
        return;
      }
      columnsSent = true;
      fieldOids = fields.map((field) => field.dataTypeID);
      const columns: ResultColumn[] = fields.map((field, index) => {
        const dataType = pgTypeName(fieldOids[index]);
        return dataType === undefined
          ? { name: field.name ?? `column${index + 1}` }
          : { name: field.name ?? `column${index + 1}`, dataType };
      });
      queue.push({ kind: 'columns', columns });
    };
    const finish = (): void => {
      settled = true;
      flush();
      queue.push(affectedRows === undefined ? { kind: 'done' } : { kind: 'done', affectedRows });
      queue.end();
    };

    const arrayConfig: pg.QueryArrayConfig = { text: sql, rowMode: 'array', types: RAW_TYPES };
    const query = new pg.Query(arrayConfig as pg.QueryConfig);
    query.on('row', (row: unknown, result: ResultLike | undefined) => {
      sendColumns(result?.fields);
      if (!Array.isArray(row)) {
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
      batch.push(row.map((value: unknown, index) => toCellValue(value, fieldOids[index])));
      if (batch.length >= ROW_BATCH_SIZE) {
        flush();
      }
    });
    query.on('error', (error: unknown) => {
      release();
      this.lastFailed = true;
      const dbError = toPgDbError(error);
      // The cancel we issued ourselves after the row limit is a success, not an error.
      if (limitHit && (dbError.code === 'cancelled' || dbError.sqlState === QUERY_CANCELLED)) {
        finish();
        return;
      }
      settled = true;
      queue.fail(dbError);
    });
    query.on('end', (result: ResultLike | undefined) => {
      release();
      this.lastFailed = false;
      if (settled) {
        return;
      }
      sendColumns(result?.fields);
      const command = result?.command?.toUpperCase();
      if (
        command !== undefined &&
        WRITE_COMMANDS.has(command) &&
        typeof result?.rowCount === 'number'
      ) {
        affectedRows = result.rowCount;
      }
      finish();
    });
    this.client.query(query);

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
   * Cancels the currently running statement via pg_cancel_backend. With a `token`,
   * only the statement that asked is cancelled: when it has already finished, the
   * cancel is skipped so it cannot hit whatever runs next.
   */
  async cancel(token?: object): Promise<void> {
    if (
      this.closed ||
      this.active === undefined ||
      (token !== undefined && this.active !== token)
    ) {
      return;
    }
    this.cancelling ??= this.sendCancel(token ?? this.active).finally(() => {
      this.cancelling = undefined;
    });
    await this.cancelling;
  }

  private async sendCancel(token: object): Promise<void> {
    const pid = (this.client as unknown as { processID?: number | null }).processID;
    if (typeof pid !== 'number') {
      throw new DbError('unsupported', 'The server did not report a backend pid');
    }
    const control = new pg.Client(clientConfig(this.config, this.tls));
    try {
      await control.connect();
      // Re-check after the control connection is up: the statement may be done by now.
      if (this.active === token) {
        await control.query({ text: 'SELECT pg_cancel_backend($1)', values: [pid] });
      }
    } catch (error) {
      throw toPgDbError(error);
    } finally {
      await control.end().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.client.end();
    } catch (_error) {
      // The socket may already be gone; closing must always succeed.
    }
  }
}

import { Connection, type ConnectionConfiguration, Request, TYPES } from 'tedious';
import { AsyncQueue } from '../../core/async-queue';
import { DbError } from '../../core/errors';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  effectivePort,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import { tlsFailure, type TlsMaterial, tlsMaterial } from '../common/tls';
import type {
  ExecuteEvent,
  ExecuteOptions,
  ResultColumn,
  Session,
  TransactionState,
} from '../driver';
import { toMssqlDbError } from './errors';
import { installExactValues } from './exact-values';
import { MssqlMetadata } from './metadata';
import { type ColumnMetadataLike, mssqlTypeName, toCellValue } from './values';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** Row batches that may wait unread before the request is paused (D58). */
export const FLOW_HIGH_WATER = 16;

/** Server messages kept for the notice of one statement (PRINT, warnings). */
const MAX_NOTICE_LENGTH = 4000;

/** Messages the server sends about the session itself, not about the statement. */
const SESSION_MESSAGES = new Set([5701, 5703]);

/** A named instance (`host\SQLEXPRESS`) is found through SQL Server Browser. */
export function splitInstance(host: string): { server: string; instance?: string } {
  const slash = host.indexOf('\\');
  return slash === -1
    ? { server: host }
    : { server: host.slice(0, slash), instance: host.slice(slash + 1) };
}

export function connectionConfig(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): ConnectionConfiguration {
  const { server, instance } = splitInstance(config.host ?? 'localhost');
  // A port given by hand wins over the instance name: tedious takes only one of them.
  const where =
    instance !== undefined && config.port === undefined
      ? { instanceName: instance }
      : { port: effectivePort(config) };
  return {
    server,
    authentication: {
      type: 'default',
      options: { userName: config.user ?? '', password: config.password ?? '' },
    },
    options: {
      ...where,
      ...(config.database === undefined || config.database === ''
        ? {}
        : { database: config.database }),
      // Without TLS settings only the login is encrypted, as every client does; a server
      // that forces encryption then says so, and the user picks a TLS mode.
      encrypt: tls !== undefined,
      // tedious checks both the chain and the name, or neither; `verify-ca` is checked
      // after the handshake instead (see verifyChain).
      trustServerCertificate: tls?.mode !== 'verify-full',
      ...(tls === undefined
        ? {}
        : {
            serverName: tls.serverName,
            cryptoCredentialsDetails: {
              ...(tls.ca === undefined ? {} : { ca: tls.ca }),
              ...(tls.cert === undefined ? {} : { cert: tls.cert }),
              ...(tls.key === undefined ? {} : { key: tls.key }),
            },
          }),
      connectTimeout: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
      // Statements run as long as they need; QueryRunner cancels on its own timeout.
      requestTimeout: 0,
      cancelTimeout: 5000,
      useUTC: true,
      rowCollectionOnDone: false,
      rowCollectionOnRequestCompletion: false,
      useColumnNames: false,
      appName: 'DataNest',
      // A failed connection is reported at once; the user decides whether to retry.
      maxRetriesOnTransientErrors: 0,
    },
  };
}

/** The socket tedious encrypts through, for checking what the handshake found. */
interface SecureSocketLike {
  readonly authorized?: boolean;
  readonly authorizationError?: unknown;
}

/**
 * `verify-ca`: the chain must lead to the trusted CA, whatever name the certificate
 * carries. Node judged it during the handshake, without refusing (tedious trusts);
 * only a name mismatch is forgiven here.
 */
export function verifyChain(connection: unknown, tls: TlsMaterial | undefined): void {
  if (tls?.mode !== 'verify-ca') {
    return;
  }
  const socket = (connection as { messageIo?: { securePair?: { cleartext?: SecureSocketLike } } })
    .messageIo?.securePair?.cleartext;
  if (socket === undefined) {
    throw new DbError('connection-failed', 'The server did not encrypt the connection');
  }
  const problem = socket.authorizationError;
  if (socket.authorized === true || problem === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return;
  }
  const code = typeof problem === 'string' ? problem : 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  const error = Object.assign(new Error(String(problem)), { code });
  throw (
    tlsFailure(error, tls.serverName) ??
    new DbError('connection-failed', `The server certificate is not trusted: ${String(problem)}`)
  );
}

function connect(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.connect((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function openMssqlSession(config: ResolvedConnectionConfig): Promise<Session> {
  installExactValues();
  const tls = await tlsMaterial(config);
  const connection = new Connection(connectionConfig(config, tls));
  // Errors between statements (a dropped socket) must not crash the host; the next
  // statement reports them as a lost connection.
  connection.on('error', () => undefined);
  // tedious ends a failed login with the last server message ("Login failed"); the
  // first one says why (4060: the database does not exist).
  const loginErrors: ServerMessage[] = [];
  const onLoginError = (message: ServerMessage): void => {
    loginErrors.push(message);
  };
  connection.on('errorMessage', onLoginError);
  try {
    await connect(connection);
    verifyChain(connection, tls);
  } catch (error) {
    connection.close();
    throw (
      tlsFailure(tlsCause(error), tls?.serverName ?? '') ??
      toMssqlDbError(loginFailure(loginErrors) ?? error)
    );
  } finally {
    connection.removeListener('errorMessage', onLoginError);
  }
  return new MssqlSession(connection);
}

/** An error or info message of the server, as tedious passes it on. */
interface ServerMessage {
  readonly number?: number;
  readonly message?: string;
}

/** The first message of a failed login as an error with the server's number. */
export function loginFailure(messages: readonly ServerMessage[]): Error | undefined {
  const [first] = messages;
  if (first?.number === undefined) {
    return undefined;
  }
  return Object.assign(new Error(first.message ?? 'Login failed'), {
    number: first.number,
    code: 'ELOGIN',
  });
}

/** tedious wraps TLS errors in its own ConnectionError; Node's code is on the cause. */
function tlsCause(error: unknown): unknown {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return typeof (cause as { code?: unknown } | null)?.code === 'string' ? cause : error;
}

/** One value of a row event: tedious pairs each value with its column. */
interface ColumnValueLike {
  readonly value: unknown;
  readonly metadata: ColumnMetadataLike;
}

/** A parameter of a catalog query; every one is text or a number. */
export type QueryParameter = string | number;

class MssqlSession implements Session {
  readonly metadata: MssqlMetadata;
  private closed = false;
  /** The server ended the connection; every later statement reports it lost. */
  private ended = false;
  /** Requests on one connection must not overlap: each waits for the one before. */
  private chain: Promise<void> = Promise.resolve();
  /** Identity of the statement on the wire; undefined between statements. */
  private active: object | undefined;

  constructor(private readonly connection: Connection) {
    this.metadata = new MssqlMetadata(async (sql, params) => await this.query(sql, params));
    connection.on('end', () => {
      this.ended = true;
    });
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /** As the server reported it: ENVCHANGE tokens begin and end transactions. */
  transactionState(): TransactionState {
    return (this.connection as unknown as { inTransaction?: boolean }).inTransaction === true
      ? 'open'
      : 'idle';
  }

  private lock(): Promise<() => void> {
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.chain;
    this.chain = previous.then(() => next);
    return previous.then(() => release);
  }

  private usable(): void {
    if (this.closed) {
      throw new DbError('internal', 'The session is closed');
    }
    if (this.ended) {
      throw new DbError('connection-failed', 'The connection to the server was lost');
    }
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    this.usable();
    const release = await this.lock();
    const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    let request: Request | undefined;
    const queue = new AsyncQueue<ExecuteEvent>({
      highWater: FLOW_HIGH_WATER,
      pause: () => {
        request?.pause();
      },
      resume: () => {
        request?.resume();
      },
    });
    let columns: ColumnMetadataLike[] = [];
    let columnsSeen = false as boolean;
    let batch: CellValue[][] = [];
    let rowCount = 0;
    let limitHit = false as boolean;
    let affected: number | undefined;
    let settled = false as boolean;
    const notices: string[] = [];
    const token = {};

    const flush = (): void => {
      if (batch.length > 0) {
        queue.push({ kind: 'rows', rows: batch });
        batch = [];
      }
    };
    const onInfo = (info: { number?: number; message?: string }): void => {
      if (info.number === undefined || !SESSION_MESSAGES.has(info.number)) {
        notices.push(info.message ?? '');
      }
    };
    const finish = (): void => {
      settled = true;
      flush();
      const notice = noticeText(notices);
      queue.push({
        kind: 'done',
        ...(affected === undefined || columnsSeen ? {} : { affectedRows: affected }),
        ...(notice === undefined ? {} : { notice }),
      });
      queue.end();
    };
    const count = (rows: number | undefined): void => {
      if (rows !== undefined) {
        affected = (affected ?? 0) + rows;
      }
    };

    try {
      this.usable();
      request = new Request(sql, (error) => {
        this.connection.removeListener('infoMessage', onInfo);
        if (this.active === token) {
          this.active = undefined;
        }
        release();
        if (settled) {
          return;
        }
        if (error === undefined || error === null) {
          finish();
          return;
        }
        const dbError = toMssqlDbError(error, sql);
        // The cancel we sent ourselves after the row limit is a success, not an error.
        if (limitHit && dbError.code === 'cancelled') {
          finish();
          return;
        }
        settled = true;
        queue.fail(dbError);
      });
      request.on('columnMetadata', (meta: unknown) => {
        flush();
        columns = Array.isArray(meta) ? (meta as ColumnMetadataLike[]) : [];
        columnsSeen = true;
        const described: ResultColumn[] = columns.map((column, index) => {
          const name =
            column.colName === undefined || column.colName === ''
              ? `column${index + 1}`
              : column.colName;
          const dataType = mssqlTypeName(column);
          return dataType === undefined ? { name } : { name, dataType };
        });
        queue.push({ kind: 'columns', columns: described });
      });
      request.on('row', (values: unknown) => {
        if (!Array.isArray(values)) {
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
        batch.push(
          (values as ColumnValueLike[]).map((column) => toCellValue(column.value, column.metadata)),
        );
        if (batch.length >= ROW_BATCH_SIZE) {
          flush();
        }
      });
      // Only statements of the batch itself count: what triggers and procedures change
      // arrives as DONEINPROC and would make one updated row look like two.
      request.on('done', count);
      this.connection.on('infoMessage', onInfo);
      this.active = token;
      this.connection.execSqlBatch(request);
    } catch (error) {
      this.connection.removeListener('infoMessage', onInfo);
      if (this.active === token) {
        this.active = undefined;
      }
      release();
      throw toMssqlDbError(error, sql);
    }

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
   * Runs a catalog query with parameters (`@p1`, `@p2`, …) and returns its rows as
   * raw values. Shares the queue with statements, so the two never overlap.
   */
  async query(sql: string, params: readonly QueryParameter[] = []): Promise<unknown[][]> {
    this.usable();
    const release = await this.lock();
    try {
      this.usable();
      return await new Promise<unknown[][]>((resolve, reject) => {
        const rows: unknown[][] = [];
        const request = new Request(sql, (error) => {
          if (error === undefined || error === null) {
            resolve(rows);
          } else {
            reject(toMssqlDbError(error));
          }
        });
        params.forEach((value, index) => {
          if (typeof value === 'number') {
            request.addParameter(`p${index + 1}`, TYPES.Int, value);
          } else {
            request.addParameter(`p${index + 1}`, TYPES.NVarChar, value);
          }
        });
        request.on('row', (values: unknown) => {
          if (Array.isArray(values)) {
            rows.push((values as ColumnValueLike[]).map((column) => column.value));
          }
        });
        this.connection.execSql(request);
      });
    } finally {
      release();
    }
  }

  /**
   * Sends the server an attention for the running statement. With a `token`, only the
   * statement that asked is cancelled, so a late cancel cannot hit the next one.
   */
  cancel(token?: object): Promise<void> {
    if (
      this.closed ||
      this.active === undefined ||
      (token !== undefined && this.active !== token)
    ) {
      return Promise.resolve();
    }
    this.connection.cancel();
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.ended) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.connection.once('end', () => {
        resolve();
      });
      this.connection.close();
    });
  }
}

function noticeText(messages: readonly string[]): string | undefined {
  const text = messages.filter((message) => message !== '').join('\n');
  if (text === '') {
    return undefined;
  }
  return text.length > MAX_NOTICE_LENGTH ? `${text.slice(0, MAX_NOTICE_LENGTH)}…` : text;
}

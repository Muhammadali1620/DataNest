import { connect } from 'node:net';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import * as mysql from 'mysql2';
import { AsyncQueue } from '../../core/async-queue';
import { DbError } from '../../core/errors';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  effectivePort,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import { sniName, tlsFailure, type TlsMaterial, tlsMaterial } from '../common/tls';
import type {
  ExecuteEvent,
  ExecuteOptions,
  ResultColumn,
  Session,
  TransactionState,
} from '../driver';
import { toMysqlDbError } from './errors';
import { MysqlMetadata } from './metadata';
import { mysqlTypeName, toCellValue } from './values';
import { msg } from '../../core/user-message';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/**
 * Row batches that may wait unread before the socket is paused (V5.2), so a dump or a
 * transfer of a huge table reads no faster than it writes.
 */
export const FLOW_HIGH_WATER = 16;

/** TCP keep-alive probes start after this much quiet, so NAT and firewalls keep the link. */
export const TCP_KEEPALIVE_DELAY_MS = 30_000;

const QUERY_INTERRUPTED = 1317; // ER_QUERY_INTERRUPTED
const LOCK_DEADLOCK = 1213; // ER_LOCK_DEADLOCK: InnoDB rolled the whole transaction back

/** SERVER_STATUS_IN_TRANS of the OK packet: a transaction is open after this statement. */
const IN_TRANSACTION = 0x0001;

/** mysql2's TLS options for a mode; it checks the name itself when it can send SNI. */
export function mysqlSsl(tls: TlsMaterial): mysql.SslOptions {
  return {
    ...(tls.ca === undefined ? {} : { ca: tls.ca }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    rejectUnauthorized: tls.mode !== 'require',
    verifyIdentity: tls.mode === 'verify-full' && sniName(tls.serverName) !== undefined,
  };
}

export function connectionOptions(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): mysql.ConnectionOptions {
  const port = effectivePort(config);
  // Through a tunnel mysql2 must still know the server's real name, because it checks
  // the certificate against `host`; the socket itself goes to the local tunnel port.
  const tunnel = config.tlsServerName;
  return {
    host: tunnel ?? config.host,
    port,
    ...(tunnel === undefined
      ? {}
      : { stream: () => connect({ host: config.host ?? '127.0.0.1', port: port ?? 0 }) }),
    ...(tls === undefined ? {} : { ssl: mysqlSsl(tls) }),
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
    // Set at the handshake: mysql2 encodes the query text in this character set too,
    // which a later SET NAMES would not change.
    charset: config.options?.charset ?? 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: TCP_KEEPALIVE_DELAY_MS,
    // Values that cannot survive a JS number arrive as text (ARCHITECTURE.md §5):
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
  };
}

export async function openMysqlSession(config: ResolvedConnectionConfig): Promise<Session> {
  const tls = await tlsMaterial(config);
  let raw: mysql.Connection;
  try {
    raw = mysql.createConnection(connectionOptions(config, tls));
  } catch (error) {
    // mysql2 rejects a character set it does not know before it connects.
    throw new DbError(
      'unsupported',
      msg('Unknown character set "{0}": {1}', config.options?.charset ?? '', String(error)),
    );
  }
  // Fatal errors between queries (e.g. a dropped socket) must not crash the host;
  // the next statement surfaces them as a normal failure.
  raw.on('error', () => undefined);
  try {
    await raw.promise().connect();
    verifyIpIdentity(raw, tls);
    if (config.readOnly === true) {
      // Every later transaction, autocommitted statements included, is read-only.
      await raw.promise().query('SET SESSION TRANSACTION READ ONLY');
    }
  } catch (error) {
    raw.destroy();
    throw tlsFailure(error, tls?.serverName ?? '') ?? toMysqlDbError(error);
  }
  return new MysqlSession(raw, config, tls);
}

/**
 * mysql2 checks the name only when it can send SNI, which is never for an IP
 * address; `verify-full` to an IP is checked here instead, before any statement.
 */
function verifyIpIdentity(raw: mysql.Connection, tls: TlsMaterial | undefined): void {
  if (tls?.mode !== 'verify-full' || sniName(tls.serverName) !== undefined) {
    return;
  }
  const socket = (raw as unknown as { stream?: Partial<TLSSocket> }).stream;
  const cert = socket?.getPeerCertificate?.();
  const problem =
    cert === undefined
      ? new Error(msg('The server did not present a certificate'))
      : checkServerIdentity(tls.serverName, cert);
  if (problem !== undefined) {
    throw problem;
  }
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
  private readonly tls: TlsMaterial | undefined;
  private cancelling: Promise<void> | undefined;
  private closed = false;
  /** Identity of the statement currently on the wire; undefined between statements. */
  private active: object | undefined;
  /** From the status flags of the last OK packet; rows do not change it. */
  private inTransaction = false;

  constructor(
    conn: mysql.Connection,
    config: ResolvedConnectionConfig,
    tls: TlsMaterial | undefined,
  ) {
    this.conn = conn;
    this.config = config;
    this.tls = tls;
    this.metadata = new MysqlMetadata(conn.promise());
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /**
   * MySQL reports the transaction in the status flags of every OK packet, which
   * BEGIN, COMMIT, writes and DDL (with its implicit commit) all end with. A SELECT
   * cannot start or end one in the default autocommit mode, so it keeps the last state.
   */
  transactionState(): TransactionState {
    return this.inTransaction ? 'open' : 'idle';
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    const queue = new AsyncQueue<ExecuteEvent>({
      highWater: FLOW_HIGH_WATER,
      pause: () => {
        this.conn.pause();
      },
      resume: () => {
        this.conn.resume();
      },
    });
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

    const token = {};
    const release = (): void => {
      if (this.active === token) {
        this.active = undefined;
      }
    };
    // mysql2 reports a lost connection (the server ended the session, the socket
    // dropped) on the connection, not on a query without a callback; without this the
    // statement would wait forever. A dead connection also refuses new queries there.
    const lost = (error: unknown): void => {
      release();
      if (!settled) {
        settled = true;
        const failure = toMysqlDbError(error);
        // Only fatal errors arrive here: "closed state" has no code of its own.
        queue.fail(
          failure.code === 'internal'
            ? new DbError('connection-failed', failure.message, { cause: error })
            : failure,
        );
      }
    };
    this.conn.on('error', lost);
    const command = this.conn.query({ sql, rowsAsArray: true });
    if (!settled) {
      this.active = token;
    }
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
        const header = row as { affectedRows?: number; serverStatus?: number };
        if (typeof header.affectedRows === 'number') {
          affectedRows = header.affectedRows;
        }
        if (typeof header.serverStatus === 'number') {
          this.inTransaction = (header.serverStatus & IN_TRANSACTION) !== 0;
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
      if (dbError.driverCode === LOCK_DEADLOCK) {
        this.inTransaction = false;
      }
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
      this.conn.off('error', lost);
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
      .createConnection({ ...connectionOptions(this.config, this.tls), database: undefined })
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

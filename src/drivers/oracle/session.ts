import oracledb from 'oracledb';
import { DbError } from '../../core/errors';
import { leadingKeyword } from '../../core/sql/statement-kind';
import { transactionControl } from '../../core/sql/transaction-control';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  effectivePort,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import type {
  ExecuteEvent,
  ExecuteOptions,
  ResultColumn,
  Session,
  TransactionState,
} from '../driver';
import { toOracleDbError } from './errors';
import { installExactDates } from './exact-dates';
import { OracleMetadata } from './metadata';
import { type OracleColumnLike, oracleTypeName, toCellValue } from './values';
import { msg } from '../../core/user-message';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** The service a connection opens when it names none: the pluggable database of Oracle Free. */
export const DEFAULT_SERVICE = 'FREEPDB1';

/**
 * Dates and numbers that the server turns into text itself (TO_CHAR, a table view
 * filter, text inserted into a DATE column) read the way DataNest shows them: ISO dates,
 * a point for decimals. The user's init SQL runs after this and may set other formats.
 */
export const SESSION_SETUP =
  "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'" +
  " NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SSXFF'" +
  " NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SSXFF TZH:TZM'" +
  " NLS_NUMERIC_CHARACTERS = '.,'";

/** Statements whose row count means rows changed; DDL and blocks report 0 or nothing. */
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** Lines of DBMS_OUTPUT read back after a PL/SQL block. */
const OUTPUT_LINES = 1000;

/** Types fetched as text, so no digit or character is lost on the way. */
const AS_TEXT = new Set<unknown>([
  oracledb.DB_TYPE_NUMBER,
  oracledb.DB_TYPE_CLOB,
  oracledb.DB_TYPE_NCLOB,
  oracledb.DB_TYPE_LONG,
  oracledb.DB_TYPE_LONG_NVARCHAR,
  oracledb.DB_TYPE_ROWID,
  oracledb.DB_TYPE_UROWID,
]);

const AS_BYTES = new Set<unknown>([oracledb.DB_TYPE_BLOB, oracledb.DB_TYPE_LONG_RAW]);

export function fetchTypeHandler(
  metadata: oracledb.Metadata<unknown>,
): oracledb.FetchTypeResponse | undefined {
  if (AS_TEXT.has(metadata.dbType)) {
    return { type: oracledb.STRING };
  }
  if (AS_BYTES.has(metadata.dbType)) {
    return { type: oracledb.BUFFER };
  }
  return undefined;
}

export function connectString(config: ResolvedConnectionConfig): string {
  const host = config.host ?? 'localhost';
  const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const service =
    config.database === undefined || config.database === '' ? DEFAULT_SERVICE : config.database;
  return `${name}:${effectivePort(config) ?? 1521}/${service}`;
}

/** Statements that are PL/SQL, after which what DBMS_OUTPUT printed is read back. */
function isPlsql(sql: string): boolean {
  const word = leadingKeyword(sql);
  return word === 'BEGIN' || word === 'DECLARE' || word === 'CALL';
}

export async function openOracleSession(config: ResolvedConnectionConfig): Promise<Session> {
  if (config.ssl !== undefined) {
    throw new DbError(
      'unsupported',
      msg(
        'TLS (TCPS) connections to Oracle are not supported yet; connect without TLS or through SSH',
      ),
    );
  }
  installExactDates();
  let connection: oracledb.Connection;
  try {
    connection = await oracledb.getConnection({
      user: config.user ?? '',
      password: config.password ?? '',
      connectString: connectString(config),
      connectTimeout: config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
    });
  } catch (error) {
    throw toOracleDbError(error);
  }
  try {
    await connection.execute(SESSION_SETUP);
    // What PL/SQL prints with DBMS_OUTPUT is shown as the statement's notice.
    await connection.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw toOracleDbError(error);
  }
  return new OracleSession(
    connection,
    config.database === undefined || config.database === '' ? DEFAULT_SERVICE : config.database,
  );
}

class OracleSession implements Session {
  readonly metadata: OracleMetadata;
  private closed = false;
  /**
   * A transaction was begun on purpose (SET TRANSACTION, a savepoint, manual mode).
   * Until it ends, statements do not commit by themselves.
   */
  private explicit = false;
  private running = false;

  constructor(
    private readonly connection: oracledb.Connection,
    service: string,
  ) {
    this.metadata = new OracleMetadata(async (sql, binds) => await this.query(sql, binds), service);
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /** As node-oracledb reports it from the server's last answer. */
  transactionState(): TransactionState {
    return this.connection.transactionInProgress === true ? 'open' : 'idle';
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    const control = transactionControl(sql, 'oracle');
    let resultSet: oracledb.ResultSet<unknown[]> | undefined;
    this.running = true;
    try {
      // Every statement commits on its own (what auto-commit means everywhere else)
      // unless a transaction was begun on purpose.
      const result = await this.connection.execute<unknown[]>(sql, [], {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        autoCommit: !this.explicit && control === 'none',
        fetchTypeHandler,
        fetchArraySize: ROW_BATCH_SIZE,
      });
      if (control === 'begin' || control === 'savepoint') {
        this.explicit = true;
      } else if (
        control === 'commit' ||
        control === 'rollback' ||
        this.connection.transactionInProgress !== true
      ) {
        this.explicit = false;
      }
      const warning = (result as { warning?: { message?: string } }).warning;
      if (warning !== undefined) {
        // ORA-24344: the routine or trigger was created, but does not compile.
        throw new DbError(
          'syntax',
          await this.compileErrors(warning.message ?? msg('Compiled with errors')),
        );
      }
      resultSet = result.resultSet;
      if (resultSet === undefined) {
        const notice = isPlsql(sql) ? await this.output() : undefined;
        yield {
          kind: 'done',
          ...(typeof result.rowsAffected === 'number' && DML.has(leadingKeyword(sql))
            ? { affectedRows: result.rowsAffected }
            : {}),
          ...(notice === undefined ? {} : { notice }),
        };
        return;
      }
      const meta = (result.metaData ?? resultSet.metaData) as readonly OracleColumnLike[];
      const columns: ResultColumn[] = meta.map((column, index) => {
        const dataType = oracleTypeName(column);
        const name = column.name === '' ? `column${index + 1}` : column.name;
        return dataType === undefined ? { name } : { name, dataType };
      });
      yield { kind: 'columns', columns };
      let sent = 0;
      while (sent < rowLimit) {
        const rows = await resultSet.getRows(Math.min(ROW_BATCH_SIZE, rowLimit - sent));
        if (rows.length === 0) {
          break;
        }
        sent += rows.length;
        const converted: CellValue[][] = rows.map((row) =>
          row.map((value, index) => toCellValue(value, meta[index] ?? { name: '' })),
        );
        yield { kind: 'rows', rows: converted };
      }
      yield { kind: 'done' };
    } catch (error) {
      throw toOracleDbError(error);
    } finally {
      this.running = false;
      // Closing the cursor also stops a query whose rows are no longer wanted.
      await resultSet?.close().catch(() => undefined);
    }
  }

  /** The compiler's own words for a routine created with errors. */
  private async compileErrors(fallback: string): Promise<string> {
    try {
      const rows = await this.query(
        `SELECT line, position, text FROM user_errors
         WHERE attribute = 'ERROR' ORDER BY name, type, sequence FETCH FIRST 5 ROWS ONLY`,
      );
      const lines = rows.map(
        (row) => `line ${String(row[0])}, column ${String(row[1])}: ${String(row[2]).trim()}`,
      );
      return lines.length === 0 ? fallback : msg('Compiled with errors: {0}', lines.join('; '));
    } catch (_error) {
      return fallback;
    }
  }

  /** What DBMS_OUTPUT printed during the last block, as one notice. */
  private async output(): Promise<string | undefined> {
    const result = await this.connection.execute<{ lines?: string[] }>(
      'BEGIN DBMS_OUTPUT.GET_LINES(:lines, :count); END;',
      {
        lines: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxArraySize: OUTPUT_LINES },
        count: { dir: oracledb.BIND_INOUT, type: oracledb.NUMBER, val: OUTPUT_LINES },
      },
    );
    const lines = (result.outBinds as { lines?: unknown } | undefined)?.lines;
    if (!Array.isArray(lines) || lines.length === 0) {
      return undefined;
    }
    const text = lines
      .map((line) => (typeof line === 'string' ? line : ''))
      .join('\n')
      .trimEnd();
    return text === '' ? undefined : text;
  }

  /** A catalog query with `:name` binds; rows as fetched values. */
  async query(sql: string, binds: Record<string, string> = {}): Promise<unknown[][]> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    try {
      const result = await this.connection.execute<unknown[]>(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        fetchTypeHandler,
      });
      return result.rows ?? [];
    } catch (error) {
      throw toOracleDbError(error);
    }
  }

  /** Breaks the statement on the wire; the server answers ORA-01013. */
  async cancel(): Promise<void> {
    if (this.closed || !this.running) {
      return;
    }
    try {
      // breakExecution, not break(): the latter waits in the connection's queue behind the
      // very statement it should stop.
      await (this.connection as unknown as { breakExecution(): Promise<void> }).breakExecution();
    } catch (error) {
      throw toOracleDbError(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // An open transaction is rolled back by the server when the connection closes.
    await this.connection.close().catch(() => undefined);
  }
}

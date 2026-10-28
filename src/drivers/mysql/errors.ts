import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';

/** What mysql2 errors actually carry; everything is optional because input is untrusted. */
interface MysqlErrorLike {
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly sqlState?: unknown;
  readonly sqlMessage?: unknown;
}

const BY_ERRNO: Readonly<Record<number, DbErrorCode>> = {
  1040: 'connection-failed', // ER_CON_COUNT_ERROR
  1044: 'permission-denied', // ER_DBACCESS_DENIED_ERROR
  1045: 'auth-failed', // ER_ACCESS_DENIED_ERROR
  1049: 'not-found', // ER_BAD_DB_ERROR
  1051: 'not-found', // ER_BAD_TABLE_ERROR
  1054: 'not-found', // ER_BAD_FIELD_ERROR
  1062: 'constraint', // ER_DUP_ENTRY
  1064: 'syntax', // ER_PARSE_ERROR
  1142: 'permission-denied', // ER_TABLEACCESS_DENIED_ERROR
  1143: 'permission-denied', // ER_COLUMNACCESS_DENIED_ERROR
  1146: 'not-found', // ER_NO_SUCH_TABLE
  1205: 'timeout', // ER_LOCK_WAIT_TIMEOUT
  1213: 'constraint', // ER_LOCK_DEADLOCK
  1305: 'not-found', // ER_SP_DOES_NOT_EXIST
  1317: 'cancelled', // ER_QUERY_INTERRUPTED
  1360: 'not-found', // ER_TRG_DOES_NOT_EXIST
  1451: 'constraint', // ER_ROW_IS_REFERENCED_2
  1452: 'constraint', // ER_NO_REFERENCED_ROW_2
  1539: 'not-found', // ER_EVENT_DOES_NOT_EXIST
  1644: 'constraint', // ER_SIGNAL_EXCEPTION (triggers)
  3024: 'timeout', // ER_QUERY_TIMEOUT
  3819: 'constraint', // ER_CHECK_CONSTRAINT_VIOLATED
  4031: 'connection-failed', // ER_CLIENT_INTERACTION_TIMEOUT
  4161: 'syntax', // ER_UNKNOWN_DATA_TYPE (MariaDB)
};

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'HANDSHAKE_NO_SSL_SUPPORT',
  'CONNECTION_REFUSED',
]);

/** Translates anything mysql2 throws into the one error type the app understands. */
export function toMysqlDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const like = (typeof error === 'object' && error !== null ? error : {}) as MysqlErrorLike;
  const errno = typeof like.errno === 'number' ? like.errno : undefined;
  const codeText = typeof like.code === 'string' ? like.code : undefined;
  let code: DbErrorCode = 'internal';
  if (errno !== undefined && BY_ERRNO[errno] !== undefined) {
    code = BY_ERRNO[errno];
  } else if (codeText !== undefined && NETWORK_CODES.has(codeText)) {
    code = 'connection-failed';
  } else if (codeText === 'ETIMEDOUT' || codeText === 'ER_QUERY_TIMEOUT') {
    code = 'timeout';
  }
  const message =
    typeof like.sqlMessage === 'string' && like.sqlMessage !== ''
      ? like.sqlMessage
      : errorMessage(error);
  return new DbError(code, message, {
    sqlState: typeof like.sqlState === 'string' ? like.sqlState : undefined,
    driverCode: errno ?? codeText,
    cause: error,
  });
}

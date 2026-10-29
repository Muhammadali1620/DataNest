import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';

/** What @clickhouse/client errors carry; everything optional because input is untrusted. */
interface ClickhouseErrorLike {
  /** The server's error number as text, e.g. `60`; or a Node network code. */
  readonly code?: unknown;
  /** The server's error name, e.g. `UNKNOWN_TABLE`. */
  readonly type?: unknown;
  readonly name?: unknown;
}

// A Map, not an object literal: a name like `toString` must find nothing.
const BY_TYPE: ReadonlyMap<string, DbErrorCode> = new Map([
  ['UNKNOWN_TABLE', 'not-found'],
  ['UNKNOWN_DATABASE', 'not-found'],
  ['UNKNOWN_IDENTIFIER', 'not-found'],
  ['UNKNOWN_FUNCTION', 'not-found'],
  ['NO_SUCH_COLUMN_IN_TABLE', 'not-found'],
  ['UNKNOWN_SETTING', 'not-found'],
  ['CANNOT_GET_CREATE_TABLE_QUERY', 'not-found'],
  ['SYNTAX_ERROR', 'syntax'],
  ['AUTHENTICATION_FAILED', 'auth-failed'],
  ['REQUIRED_PASSWORD', 'auth-failed'],
  ['WRONG_PASSWORD', 'auth-failed'],
  ['UNKNOWN_USER', 'auth-failed'],
  ['ACCESS_DENIED', 'permission-denied'],
  ['READONLY', 'permission-denied'],
  ['QUERY_WAS_CANCELLED', 'cancelled'],
  ['TIMEOUT_EXCEEDED', 'timeout'],
  ['TOO_MANY_SIMULTANEOUS_QUERIES', 'busy'],
  ['SESSION_IS_LOCKED', 'busy'],
  ['TYPE_MISMATCH', 'constraint'],
  ['CANNOT_CONVERT_TYPE', 'constraint'],
  ['ILLEGAL_TYPE_OF_ARGUMENT', 'constraint'],
  ['VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE', 'constraint'],
  ['CANNOT_INSERT_NULL_IN_ORDINARY_COLUMN', 'constraint'],
  ['INCORRECT_DATA', 'constraint'],
  ['ILLEGAL_DIVISION', 'constraint'],
  ['FUNCTION_THROW_IF_VALUE_IS_NON_ZERO', 'constraint'],
  ['UNKNOWN_ELEMENT_IN_ENUM', 'constraint'],
  ['DECIMAL_OVERFLOW', 'constraint'],
  ['TOO_LARGE_STRING_SIZE', 'constraint'],
]);

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ECONNABORTED',
]);

/**
 * Translates anything @clickhouse/client throws into the one error type the app
 * understands. With the statement, a syntax error's byte position becomes a position.
 */
export function toClickhouseDbError(error: unknown, sql?: string): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const like = (typeof error === 'object' && error !== null ? error : {}) as ClickhouseErrorLike;
  const type = typeof like.type === 'string' ? like.type : undefined;
  const codeText = typeof like.code === 'string' ? like.code : undefined;
  const message = errorMessage(error);
  let code: DbErrorCode = 'internal';
  if (type !== undefined && BY_TYPE.has(type)) {
    code = BY_TYPE.get(type) ?? 'internal';
  } else if (type === undefined && /\bCANNOT_PARSE_\w+|\bCANNOT_READ_\w+/u.test(message)) {
    code = 'constraint';
  } else if (/^CANNOT_PARSE_|^CANNOT_READ_/u.test(type ?? '')) {
    code = 'constraint';
  } else if (like.name === 'AbortError' || /\babort(ed)?\b/iu.test(message)) {
    code = 'cancelled';
  } else if (codeText !== undefined && NETWORK_CODES.has(codeText)) {
    code = 'connection-failed';
  } else if (codeText === 'ETIMEDOUT' || /^timeout error/iu.test(message)) {
    code = 'timeout';
  }
  const position = sql === undefined ? undefined : syntaxPosition(message, sql);
  return new DbError(code, message, {
    driverCode: type ?? codeText,
    ...(position === undefined ? {} : { position }),
    cause: error,
  });
}

/** `Syntax error: failed at position 8 ('x')`: a 1-based byte offset into the statement. */
export function syntaxPosition(message: string, sql: string): number | undefined {
  const match = /failed at position (\d+)/u.exec(message);
  if (match === null) {
    return undefined;
  }
  const bytes = Number(match[1]) - 1;
  let used = 0;
  let index = 0;
  for (const char of sql) {
    if (used >= bytes) {
      return index;
    }
    used += Buffer.byteLength(char);
    index += char.length;
  }
  return used >= bytes ? index : undefined;
}

import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';

/** What pg errors actually carry; everything is optional because input is untrusted. */
interface PgErrorLike {
  readonly code?: unknown;
  /** 1-based character position of the error in the SQL, as text. */
  readonly position?: unknown;
  readonly detail?: unknown;
  readonly message?: unknown;
}

/** Exact SQLSTATEs first, then whole classes by two-character prefix. */
const BY_SQLSTATE: Readonly<Record<string, DbErrorCode>> = {
  '28000': 'auth-failed',
  '28P01': 'auth-failed',
  '3D000': 'not-found', // database does not exist
  '3F000': 'not-found', // schema does not exist
  '42P01': 'not-found', // undefined table
  '42703': 'not-found', // undefined column
  '42883': 'not-found', // undefined function
  '42601': 'syntax',
  '42501': 'permission-denied',
  '57014': 'cancelled', // query_canceled
  '57P05': 'timeout', // idle session timeout
  '53300': 'connection-failed', // too many connections
};

const BY_CLASS: Readonly<Record<string, DbErrorCode>> = {
  '08': 'connection-failed',
  '22': 'constraint', // data exception (bad cast, division by zero, …)
  '23': 'constraint',
  '28': 'auth-failed',
  '42': 'syntax', // remaining syntax/access class errors
  '57': 'connection-failed', // operator intervention (shutdown, crash)
  '25': 'internal', // invalid transaction state
};

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);

/** Translates anything pg throws into the one error type the app understands. */
export function toPgDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const like = (typeof error === 'object' && error !== null ? error : {}) as PgErrorLike;
  const sqlState = typeof like.code === 'string' && like.code.length === 5 ? like.code : undefined;
  const codeText = typeof like.code === 'string' ? like.code : undefined;
  let code: DbErrorCode = 'internal';
  if (sqlState !== undefined) {
    code = BY_SQLSTATE[sqlState] ?? BY_CLASS[sqlState.slice(0, 2)] ?? 'internal';
  } else if (codeText !== undefined && NETWORK_CODES.has(codeText)) {
    code = 'connection-failed';
  } else if (codeText === 'ETIMEDOUT') {
    code = 'timeout';
  } else if (errorMessage(error).toLowerCase().includes('timeout')) {
    // pg reports its connectionTimeoutMillis as a plain Error without a code.
    code = 'connection-failed';
  }
  const rawPosition =
    typeof like.position === 'string' ? Number.parseInt(like.position, 10) : undefined;
  const position =
    rawPosition !== undefined && Number.isInteger(rawPosition) && rawPosition >= 1
      ? rawPosition - 1
      : undefined;
  return new DbError(code, errorMessage(error), {
    sqlState,
    driverCode: codeText,
    position,
    detail: typeof like.detail === 'string' ? like.detail : undefined,
    cause: error,
  });
}

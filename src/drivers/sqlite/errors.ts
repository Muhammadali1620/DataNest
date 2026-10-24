import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';

/** What node:sqlite errors actually carry; everything is optional (untrusted input). */
interface SqliteErrorLike {
  readonly code?: unknown;
  /** Extended result code, e.g. 1555 = SQLITE_CONSTRAINT_PRIMARYKEY. */
  readonly errcode?: unknown;
  readonly message?: unknown;
}

/** Primary result codes (extended code & 0xff). */
const BY_PRIMARY: Readonly<Record<number, DbErrorCode>> = {
  3: 'permission-denied', // SQLITE_PERM
  5: 'timeout', // SQLITE_BUSY
  6: 'timeout', // SQLITE_LOCKED
  8: 'permission-denied', // SQLITE_READONLY
  9: 'cancelled', // SQLITE_INTERRUPT
  10: 'connection-failed', // SQLITE_IOERR
  11: 'internal', // SQLITE_CORRUPT
  14: 'connection-failed', // SQLITE_CANTOPEN
  18: 'constraint', // SQLITE_TOOBIG
  19: 'constraint', // SQLITE_CONSTRAINT
  20: 'constraint', // SQLITE_MISMATCH
  23: 'permission-denied', // SQLITE_AUTH
  26: 'connection-failed', // SQLITE_NOTADB
};

/** SQLITE_ERROR (1) covers everything from typos to missing tables: split by message. */
function classifyGenericError(message: string): DbErrorCode {
  const text = message.toLowerCase();
  if (
    text.includes('no such table') ||
    text.includes('no such column') ||
    text.includes('no such index') ||
    text.includes('no such function') ||
    text.includes('no such module')
  ) {
    return 'not-found';
  }
  if (text.includes('syntax error') || text.includes('unrecognized token')) {
    return 'syntax';
  }
  if (text.includes('already exists')) {
    return 'constraint';
  }
  return 'internal';
}

/** Translates anything node:sqlite throws into the one error type the app understands. */
export function toSqliteDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const like = (typeof error === 'object' && error !== null ? error : {}) as SqliteErrorLike;
  const errcode = typeof like.errcode === 'number' ? like.errcode : undefined;
  const message = errorMessage(error);
  let code: DbErrorCode = 'internal';
  if (errcode !== undefined) {
    const primary = errcode & 0xff;
    code = primary === 1 ? classifyGenericError(message) : (BY_PRIMARY[primary] ?? 'internal');
  } else if (typeof like.code === 'string' && like.code.startsWith('ERR_SQLITE')) {
    code = classifyGenericError(message);
  }
  return new DbError(code, message, {
    driverCode: errcode ?? (typeof like.code === 'string' ? like.code : undefined),
    cause: error,
  });
}

/** A flat {code, message} that survives structured clone across the worker boundary. */
export interface WireError {
  readonly code: string;
  readonly message: string;
}

export function toWireError(error: unknown): WireError {
  const dbError = toSqliteDbError(error);
  return { code: dbError.code, message: dbError.message };
}

export function fromWireError(wire: WireError): DbError {
  const codes: readonly DbErrorCode[] = [
    'connection-failed',
    'auth-failed',
    'timeout',
    'cancelled',
    'syntax',
    'constraint',
    'permission-denied',
    'not-found',
    'unsupported',
    'internal',
  ];
  const code = (codes as readonly string[]).includes(wire.code)
    ? (wire.code as DbErrorCode)
    : 'internal';
  return new DbError(code, wire.message);
}

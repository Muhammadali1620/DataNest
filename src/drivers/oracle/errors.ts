import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';

/** What node-oracledb errors carry; everything optional because input is untrusted. */
interface OracleErrorLike {
  /** ORA-00942 → `ORA-00942`; node-oracledb's own codes are `NJS-…`. */
  readonly code?: unknown;
  readonly errorNum?: unknown;
  /** Character offset of the error in the statement, where the server knows it. */
  readonly offset?: unknown;
}

const BY_NUMBER: ReadonlyMap<number, DbErrorCode> = new Map([
  [942, 'not-found'], // table or view does not exist
  [904, 'not-found'], // invalid identifier (column)
  [4043, 'not-found'], // object does not exist
  [31603, 'not-found'], // DBMS_METADATA: object not found in schema
  [2289, 'not-found'], // sequence does not exist
  [1918, 'not-found'], // user does not exist
  [12514, 'not-found'], // listener does not know of service
  [900, 'syntax'], // invalid SQL statement
  [905, 'syntax'], // missing keyword
  [906, 'syntax'], // missing left parenthesis
  [907, 'syntax'], // missing right parenthesis
  [911, 'syntax'], // invalid character
  [923, 'syntax'], // FROM keyword not found
  [933, 'syntax'], // SQL command not properly ended
  [936, 'syntax'], // missing expression
  [1756, 'syntax'], // quoted string not properly terminated
  [6550, 'syntax'], // PL/SQL compilation error
  [1017, 'auth-failed'], // invalid username/password
  [28000, 'auth-failed'], // account is locked
  [28001, 'auth-failed'], // password has expired
  [1031, 'permission-denied'], // insufficient privileges
  [1013, 'cancelled'], // user requested cancel
  [1, 'constraint'], // unique constraint violated
  [1400, 'constraint'], // cannot insert NULL
  [1407, 'constraint'], // cannot update to NULL
  [2290, 'constraint'], // check constraint violated
  [2291, 'constraint'], // parent key not found
  [2292, 'constraint'], // child record found
  [1438, 'constraint'], // value larger than precision
  [12899, 'constraint'], // value too large for column
  [1722, 'constraint'], // invalid number
  [1840, 'constraint'], // input value not long enough for date format
  [1841, 'constraint'],
  [1843, 'constraint'], // not a valid month
  [1847, 'constraint'], // day of month must be between 1 and last day
  [1861, 'constraint'], // literal does not match format string
  [1476, 'constraint'], // divisor is equal to zero
  [60, 'constraint'], // deadlock detected
  [54, 'busy'], // resource busy and acquire with NOWAIT
  [3113, 'connection-failed'], // end-of-file on communication channel
  [3114, 'connection-failed'], // not connected
  [3135, 'connection-failed'], // connection lost contact
  [12541, 'connection-failed'], // no listener
  [12170, 'timeout'], // connect timeout
]);

/** NJS-518: the listener knows no such service, the database the connection names. */
const NJS_NOT_FOUND = new Set(['NJS-518']);

/** node-oracledb's own codes for connections it could not make or lost. */
const NJS_CONNECTION = new Set(['NJS-500', 'NJS-501', 'NJS-503', 'NJS-511', 'NJS-003', 'NJS-040']);

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);

/** Translates anything node-oracledb throws into the one error type the app understands. */
export function toOracleDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const like = (typeof error === 'object' && error !== null ? error : {}) as OracleErrorLike;
  const codeText = typeof like.code === 'string' ? like.code : undefined;
  const fromCode = /^ORA-(\d+)$/u.exec(codeText ?? '');
  const number =
    typeof like.errorNum === 'number' && like.errorNum > 0
      ? like.errorNum
      : fromCode === null
        ? undefined
        : Number(fromCode[1]);
  const message = errorMessage(error);
  let code: DbErrorCode = 'internal';
  if (number !== undefined && BY_NUMBER.has(number)) {
    code = BY_NUMBER.get(number) ?? 'internal';
  } else if (number !== undefined && number >= 20_000 && number <= 20_999) {
    // RAISE_APPLICATION_ERROR: a rule of the application, in a trigger or a routine.
    code = 'constraint';
  } else if (codeText !== undefined && NJS_NOT_FOUND.has(codeText)) {
    code = 'not-found';
  } else if (
    codeText !== undefined &&
    (NJS_CONNECTION.has(codeText) || NETWORK_CODES.has(codeText))
  ) {
    code = 'connection-failed';
  } else if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/u.test(message)) {
    code = 'connection-failed';
  }
  const offset = typeof like.offset === 'number' && like.offset > 0 ? like.offset : undefined;
  return new DbError(code, message, {
    driverCode: number === undefined ? codeText : `ORA-${String(number).padStart(5, '0')}`,
    ...(offset === undefined ? {} : { position: offset }),
    cause: error,
  });
}

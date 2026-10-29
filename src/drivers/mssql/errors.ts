import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import { unquoteIdentifier } from '../../core/sql/identifiers';
import { syntaxOf, textOf, tokenize } from '../../core/sql/tokenizer';

/** What tedious errors carry; everything is optional because input is untrusted. */
interface TediousErrorLike {
  /** tedious' own code: ELOGIN, ESOCKET, ETIMEOUT, ECANCEL, EREQUEST, … */
  readonly code?: unknown;
  /** The server's error number, for errors the server sent. */
  readonly number?: unknown;
  /** 1-based line of the batch the error is on. */
  readonly lineNumber?: unknown;
  readonly procName?: unknown;
  /** A connection error may wrap the first of several (`AggregateError`). */
  readonly errors?: unknown;
}

const BY_NUMBER: Readonly<Record<number, DbErrorCode>> = {
  102: 'syntax', // Incorrect syntax near …
  105: 'syntax', // Unclosed quotation mark
  156: 'syntax', // Incorrect syntax near the keyword …
  170: 'syntax',
  2715: 'syntax', // Column, parameter, or variable: cannot find data type
  207: 'not-found', // Invalid column name
  208: 'not-found', // Invalid object name
  2812: 'not-found', // Could not find stored procedure
  3701: 'not-found', // Cannot drop … because it does not exist
  4060: 'not-found', // Cannot open database requested by the login
  911: 'not-found', // Database does not exist
  15151: 'not-found', // Cannot find the object, because it does not exist
  229: 'permission-denied', // The … permission was denied on the object
  230: 'permission-denied',
  262: 'permission-denied', // … permission denied in database
  297: 'permission-denied',
  300: 'permission-denied',
  916: 'permission-denied', // The server principal is not able to access the database
  1088: 'permission-denied', // Cannot find the object, or you do not have permission
  15247: 'permission-denied',
  18456: 'auth-failed', // Login failed for user
  18452: 'auth-failed', // The login is from an untrusted domain
  18486: 'auth-failed', // The account is locked out
  18487: 'auth-failed', // The password has expired
  18488: 'auth-failed', // The password must be changed
  515: 'constraint', // Cannot insert the value NULL
  547: 'constraint', // The statement conflicted with a FOREIGN KEY / CHECK constraint
  2601: 'constraint', // Cannot insert duplicate key row (unique index)
  2627: 'constraint', // Violation of PRIMARY KEY / UNIQUE constraint
  2628: 'constraint', // String or binary data would be truncated
  8152: 'constraint',
  8114: 'constraint', // Error converting data type
  245: 'constraint', // Conversion failed
  241: 'constraint', // Conversion failed when converting date and/or time
  8115: 'constraint', // Arithmetic overflow
  8134: 'constraint', // Divide by zero
  1205: 'constraint', // Deadlock victim: the transaction was rolled back
  1222: 'timeout', // Lock request time out period exceeded
  3621: 'internal', // The statement has been terminated (follows the real error)
};

/** tedious' own codes, for errors that never reached the server. */
const BY_CODE: Readonly<Record<string, DbErrorCode>> = {
  ELOGIN: 'auth-failed',
  ESOCKET: 'connection-failed',
  ECONNCLOSED: 'connection-failed',
  EINSTLOOKUP: 'connection-failed',
  ETLS: 'connection-failed',
  ETIMEOUT: 'timeout',
  ECANCEL: 'cancelled',
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

/** Errors THROW and RAISERROR raise with numbers of their own (triggers, checks in code). */
const FIRST_USER_ERROR = 50_000;

/**
 * Translates anything tedious throws into the one error type the app understands.
 * With the batch that failed, the server's line number becomes a position.
 */
export function toMssqlDbError(error: unknown, sql?: string): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const outer = (typeof error === 'object' && error !== null ? error : {}) as TediousErrorLike;
  // Several server errors arrive together (547, then 3621 "statement terminated"); the
  // first one that has a number says what happened.
  const primary = serverError(outer.errors);
  const like = outer.number === undefined && primary !== undefined ? primary : outer;
  const number = typeof like.number === 'number' ? like.number : undefined;
  const codeText = typeof like.code === 'string' ? like.code : undefined;
  const inner = innerCode(outer.errors);
  let code: DbErrorCode = 'internal';
  if (number !== undefined && BY_NUMBER[number] !== undefined) {
    code = BY_NUMBER[number];
  } else if (number !== undefined && number >= FIRST_USER_ERROR) {
    code = 'constraint';
  } else if (inner !== undefined && NETWORK_CODES.has(inner)) {
    code = 'connection-failed';
  } else if (codeText !== undefined && BY_CODE[codeText] !== undefined) {
    // A login failure the server explained (18456) is handled above; ELOGIN alone
    // also covers "cannot open database", which is not about the password.
    code =
      codeText === 'ELOGIN' && /cannot open database/iu.test(errorMessage(error))
        ? 'not-found'
        : BY_CODE[codeText];
  } else if (codeText !== undefined && NETWORK_CODES.has(codeText)) {
    code = 'connection-failed';
  }
  const line = typeof like.lineNumber === 'number' && like.lineNumber >= 1 ? like.lineNumber : 0;
  const procedure = typeof like.procName === 'string' && like.procName !== '' ? like.procName : '';
  // The line is the only position SQL Server gives. Inside a procedure it is the
  // procedure's line, not the batch's, so the detail says where instead.
  const position =
    procedure === '' && line > 0 && sql !== undefined
      ? positionOf(sql, line, errorMessage(like === outer ? error : like))
      : undefined;
  return new DbError(code, errorMessage(like === outer ? error : like), {
    driverCode: number ?? codeText,
    ...(position === undefined ? {} : { position }),
    ...(procedure === '' ? {} : { detail: `In ${procedure}, line ${line}` }),
    cause: error,
  });
}

/** `Invalid object name 'x'`, `Incorrect syntax near the keyword 'FROM'`, … */
const NAMED = /(?:near(?: the keyword)?|name|procedure) '([^']*)'/u;

/**
 * Where on its line the error is: at the name the message quotes, when that line has
 * it, else at the start of the line.
 */
export function positionOf(sql: string, line: number, message: string): number | undefined {
  const start = lineStart(sql, line);
  const quoted = NAMED.exec(message)?.[1];
  if (start === undefined || quoted === undefined || quoted === '') {
    return start;
  }
  const wanted = (quoted.split('.').at(-1) ?? quoted).toLowerCase();
  const end = sql.indexOf('\n', start);
  for (const token of tokenize(sql.slice(start, end === -1 ? undefined : end), syntaxOf('mssql'))) {
    const text = textOf(sql.slice(start), token);
    const bare = token.kind === 'quoted-identifier' ? unquoteIdentifier(text) : text;
    if (
      (token.kind === 'word' || token.kind === 'quoted-identifier') &&
      bare.toLowerCase() === wanted
    ) {
      return start + token.start;
    }
  }
  return start;
}

/** Offset of the first non-blank character of a 1-based line; undefined past the end. */
export function lineStart(sql: string, line: number): number | undefined {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const newline = sql.indexOf('\n', offset);
    if (newline === -1) {
      return undefined;
    }
    offset = newline + 1;
  }
  while (offset < sql.length && (sql[offset] === ' ' || sql[offset] === '\t')) {
    offset++;
  }
  return offset;
}

function serverError(errors: unknown): (TediousErrorLike & Error) | undefined {
  if (!Array.isArray(errors)) {
    return undefined;
  }
  return (errors as unknown[]).find(
    (item): item is TediousErrorLike & Error =>
      item instanceof Error && typeof (item as TediousErrorLike).number === 'number',
  );
}

function innerCode(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) {
    return undefined;
  }
  for (const item of errors as unknown[]) {
    const code = (item as { code?: unknown } | null)?.code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

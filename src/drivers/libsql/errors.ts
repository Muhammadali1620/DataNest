import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';

/** The error object of a Hrana response: `{ message, code }`, both optional (untrusted input). */
export interface HranaError {
  readonly message?: unknown;
  readonly code?: unknown;
}

/** SQLite's own wording, which sqld passes on in `message`, for the generic SQLITE_ERROR. */
function classifyMessage(message: string): DbErrorCode {
  const text = message.toLowerCase();
  if (
    text.includes('no such table') ||
    text.includes('no such column') ||
    text.includes('no such index') ||
    text.includes('no such function')
  ) {
    return 'not-found';
  }
  if (text.includes('syntax error') || text.includes('unrecognized token')) {
    return 'syntax';
  }
  if (text.includes('already exists')) {
    return 'constraint';
  }
  if (text.includes('readonly') || text.includes('read-only') || text.includes('read only')) {
    return 'permission-denied';
  }
  return 'internal';
}

function classifyCode(code: string, message: string): DbErrorCode {
  if (code.startsWith('SQLITE_CONSTRAINT') || code === 'SQLITE_TOOBIG') {
    return 'constraint';
  }
  if (code.startsWith('SQLITE_READONLY') || code === 'SQLITE_AUTH' || code === 'SQLITE_PERM') {
    return 'permission-denied';
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return 'timeout';
  }
  if (code === 'SQLITE_INTERRUPT') {
    return 'cancelled';
  }
  if (code === 'SQL_PARSE_ERROR' || code === 'SQL_INPUT_ERROR') {
    return 'syntax';
  }
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_FAILED' || code === 'AUTH_JWT_EXPIRED') {
    return 'auth-failed';
  }
  return classifyMessage(message);
}

/** Maps the code and text of a Hrana `error` (a failed request in a pipeline). */
export function fromHranaError(error: HranaError): DbError {
  const code = typeof error.code === 'string' ? error.code : undefined;
  const message =
    typeof error.message === 'string' && error.message !== ''
      ? error.message
      : (code ?? msg('The server reported an error without a message'));
  const mapped = code === undefined ? classifyMessage(message) : classifyCode(code, message);
  return new DbError(mapped, message, code === undefined ? {} : { driverCode: code });
}

/** What an HTTP failure of the server means: sign-in, or a plain fault. */
export function fromHttpStatus(status: number, body: string): DbError {
  let detail: HranaError = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      detail = parsed;
    }
  } catch {
    detail = body.trim() === '' ? {} : { message: body.trim().slice(0, 500) };
  }
  const text =
    typeof detail.message === 'string' && detail.message !== '' ? detail.message : undefined;
  if (status === 401 || status === 403) {
    return new DbError('auth-failed', text ?? msg('The server refused the auth token'), {
      driverCode: status,
    });
  }
  const base = fromHranaError(detail);
  if (base.code !== 'internal') {
    return base;
  }
  return new DbError(
    status >= 500 ? 'connection-failed' : 'internal',
    text ?? msg('The server answered with HTTP status {0}', String(status)),
    { driverCode: status },
  );
}

/** A failure of the network itself (refused, reset, unreachable, timed out). */
export function toLibsqlDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const text = errorMessage(error);
  if (typeof code === 'string' && /^(E[A-Z]+|ERR_[A-Z_]+)$/u.test(code)) {
    return new DbError('connection-failed', text, { driverCode: code, cause: error });
  }
  return new DbError('internal', text, { cause: error });
}

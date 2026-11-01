import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';

/** One entry of the `errors` array of a Query API answer (untrusted input). */
export interface Neo4jError {
  readonly code?: unknown;
  readonly message?: unknown;
}

/** The class of a Neo4j status code: `Neo.ClientError.Statement.SyntaxError` → its tail. */
function classifyCode(code: string, message: string): DbErrorCode {
  if (code.startsWith('Neo.ClientError.Security.')) {
    return code.endsWith('Forbidden') || code.endsWith('AuthorizationFailed')
      ? 'permission-denied'
      : 'auth-failed';
  }
  if (code.endsWith('Statement.SyntaxError') || code.endsWith('Statement.ParameterMissing')) {
    return 'syntax';
  }
  if (code.endsWith('Statement.AccessMode')) {
    return 'permission-denied';
  }
  if (code.endsWith('DatabaseNotFound') || code.endsWith('Statement.EntityNotFound')) {
    return 'not-found';
  }
  if (code.includes('.Schema.') && /constraint/iu.test(code + message)) {
    return 'constraint';
  }
  if (code.endsWith('TransactionTimedOut') || code.includes('.TransientError.')) {
    return 'timeout';
  }
  if (code.endsWith('Request.Invalid') || code.endsWith('Statement.TypeError')) {
    return 'syntax';
  }
  return 'internal';
}

/** Maps the first error of an answer (Neo4j sends a list; the first one explains the rest). */
export function fromNeo4jError(error: Neo4jError): DbError {
  const code = typeof error.code === 'string' ? error.code : undefined;
  const message =
    typeof error.message === 'string' && error.message !== ''
      ? error.message
      : (code ?? msg('The server reported an error without a message'));
  const mapped = code === undefined ? 'internal' : classifyCode(code, message);
  return new DbError(mapped, message, code === undefined ? {} : { driverCode: code });
}

/** What an HTTP failure of the server means: sign-in, a missing database, or a plain fault. */
export function fromHttpStatus(status: number, body: string): DbError {
  let errors: unknown;
  try {
    errors = (JSON.parse(body) as { errors?: unknown }).errors;
  } catch {
    errors = undefined;
  }
  const first = Array.isArray(errors) ? (errors[0] as Neo4jError | undefined) : undefined;
  if (first !== undefined && typeof first === 'object') {
    const mapped = fromNeo4jError(first);
    if (mapped.code !== 'internal' || status < 500) {
      return mapped;
    }
  }
  if (status === 401 || status === 403) {
    return new DbError('auth-failed', msg('The server refused the user name or password'), {
      driverCode: status,
    });
  }
  if (status === 404) {
    return new DbError(
      'connection-failed',
      msg('The server has no Query API at this address: Neo4j 5.19 or newer is needed'),
      { driverCode: status },
    );
  }
  const text = typeof first?.message === 'string' ? first.message : undefined;
  return new DbError(
    status >= 500 ? 'connection-failed' : 'internal',
    text ?? msg('The server answered with HTTP status {0}', String(status)),
    { driverCode: status },
  );
}

/** A failure of the network itself (refused, reset, unreachable, timed out). */
export function toNeo4jDbError(error: unknown): DbError {
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

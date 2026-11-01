// Maps what the Cassandra driver throws to DbError. The driver names its errors (`ResponseError`
// carries a protocol `code`; `NoHostAvailableError` lists the hosts it tried), so the class and the
// code decide, never the wording of a message.

import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';

/** Error codes of the native protocol that matter here. */
const CODES = {
  badCredentials: 0x0100,
  unavailable: 0x1000,
  overloaded: 0x1001,
  bootstrapping: 0x1002,
  writeTimeout: 0x1100,
  readTimeout: 0x1200,
  syntax: 0x2000,
  unauthorized: 0x2100,
  invalid: 0x2200,
  config: 0x2300,
  alreadyExists: 0x2400,
} as const;

interface DriverErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly innerErrors?: unknown;
}

function codeOf(error: DriverErrorLike): DbErrorCode {
  switch (error.code) {
    case CODES.badCredentials:
      return 'auth-failed';
    case CODES.unavailable:
    case CODES.overloaded:
    case CODES.bootstrapping:
      return 'connection-failed';
    case CODES.writeTimeout:
    case CODES.readTimeout:
      return 'timeout';
    case CODES.syntax:
      return 'syntax';
    case CODES.unauthorized:
      return 'permission-denied';
    case CODES.alreadyExists:
      return 'constraint';
    case CODES.invalid:
    case CODES.config: {
      // "Invalid" covers everything the server judges wrong about a statement; a missing
      // keyspace or table is the one the user can act on.
      const text = typeof error.message === 'string' ? error.message : '';
      return /(does not exist|unconfigured (table|keyspace)|unknown keyspace|not found)/iu.test(
        text,
      )
        ? 'not-found'
        : 'syntax';
    }
    default:
      return 'internal';
  }
}

/** The first reason a host could not be reached, from `NoHostAvailableError.innerErrors`. */
function reachReason(inner: unknown): string | undefined {
  if (typeof inner !== 'object' || inner === null) {
    return undefined;
  }
  for (const value of Object.values(inner)) {
    const text = errorMessage(value);
    if (text !== '') {
      return text;
    }
  }
  return undefined;
}

/** Whether an inner error means the user name or password was refused. */
function refusedSignIn(inner: unknown): boolean {
  if (typeof inner !== 'object' || inner === null) {
    return false;
  }
  return Object.values(inner).some((value) => {
    const error = value as DriverErrorLike | null;
    return (
      error?.name === 'AuthenticationError' ||
      (error?.name === 'ResponseError' && error.code === CODES.badCredentials)
    );
  });
}

export function toCassandraDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const like = (typeof error === 'object' && error !== null ? error : {}) as DriverErrorLike;
  const text = errorMessage(error);
  switch (like.name) {
    case 'NoHostAvailableError': {
      if (refusedSignIn(like.innerErrors)) {
        return new DbError('auth-failed', msg('The server refused the user name or password'), {
          cause: error,
        });
      }
      const reason = reachReason(like.innerErrors);
      return new DbError(
        'connection-failed',
        reason === undefined
          ? msg('No Cassandra node could be reached')
          : msg('No Cassandra node could be reached: {0}', reason),
        { cause: error },
      );
    }
    case 'AuthenticationError':
      return new DbError('auth-failed', msg('The server refused the user name or password'), {
        cause: error,
      });
    case 'OperationTimedOutError':
      return new DbError('timeout', msg('The server did not answer in time'), { cause: error });
    case 'ResponseError': {
      const mapped = codeOf(like);
      return new DbError(
        mapped,
        text,
        typeof like.code === 'number' ? { driverCode: like.code, cause: error } : { cause: error },
      );
    }
    case 'ArgumentError':
      return new DbError('syntax', text, { cause: error });
    default:
      break;
  }
  const code = like.code;
  if (typeof code === 'string' && /^(E[A-Z]+|ERR_[A-Z_]+)$/u.test(code)) {
    return new DbError('connection-failed', text, { driverCode: code, cause: error });
  }
  return new DbError('internal', text, { cause: error });
}

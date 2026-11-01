// etcd answers a failure with an HTTP status and a JSON body in gRPC's shape:
// `{"code":5,"message":"etcdserver: ...","error":"etcdserver: ..."}`. The gRPC code
// says what went wrong far better than the HTTP status the gateway derived from it.
// Network failures carry Node's codes and are the same as for any HTTP driver.

import { DbError, type DbErrorCode } from '../../core/errors';
import { networkFailure } from '../elasticsearch/errors';

export { networkFailure };

/** gRPC status codes → the kinds of error the app understands (§9). */
export function grpcKind(code: number | undefined, status: number): DbErrorCode {
  switch (code) {
    case 3: // InvalidArgument: empty key, bad range, name too long
      return 'syntax';
    case 4: // DeadlineExceeded
      return 'timeout';
    case 5: // NotFound: no such lease or user
      return 'not-found';
    case 6: // AlreadyExists
    case 8: // ResourceExhausted: database space exceeded, request too large
    case 9: // FailedPrecondition
    case 10: // Aborted
      return 'constraint';
    case 7: // PermissionDenied
      return 'permission-denied';
    case 14: // Unavailable: no leader, leader changed
      return 'busy';
    case 16: // Unauthenticated
      return 'auth-failed';
    case undefined:
    default:
      break;
  }
  if (status === 401) {
    return 'auth-failed';
  }
  if (status === 403) {
    return 'permission-denied';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 408 || status === 504) {
    return 'timeout';
  }
  if (status === 429 || status === 503) {
    return 'busy';
  }
  return status >= 400 && status < 500 ? 'syntax' : 'internal';
}

interface ErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly error?: unknown;
}

/** The text a failed answer carries: the gateway's message, else the body, else the status. */
export function failureText(status: number, body: string): { code?: number; text: string } {
  try {
    const parsed = JSON.parse(body) as ErrorBody;
    const code = typeof parsed.code === 'number' ? parsed.code : undefined;
    const text =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : undefined;
    if (text !== undefined) {
      return code === undefined ? { text } : { code, text };
    }
  } catch {
    // Not JSON (a proxy's page): the status says it.
  }
  const trimmed = body.trim();
  return { text: trimmed === '' ? `HTTP ${status}` : `HTTP ${status}: ${trimmed.slice(0, 300)}` };
}

export function etcdFailure(status: number, body: string): DbError {
  const { code, text } = failureText(status, body);
  return new DbError(grpcKind(code, status), text, { driverCode: code ?? status });
}

/** True when the cluster refused the token and signing in again may help. */
export function isTokenRefusal(error: unknown): boolean {
  return (
    error instanceof DbError &&
    error.code === 'auth-failed' &&
    /invalid auth token|token is not provided|auth token/iu.test(error.message)
  );
}

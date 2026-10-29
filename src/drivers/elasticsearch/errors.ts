// Elasticsearch answers a failure with an HTTP status and a JSON body that names the
// error (`index_not_found_exception`, `security_exception`); network failures carry
// Node's codes. Both become the one error type the app understands (§9).

import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import type { ElasticResponse } from '../elastic-driver';

/** The kind of a failed answer, by its status. */
export function statusKind(status: number): DbErrorCode {
  if (status === 401) {
    return 'auth-failed';
  }
  if (status === 403) {
    return 'permission-denied';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 409) {
    return 'constraint';
  }
  if (status === 408 || status === 504) {
    return 'timeout';
  }
  if (status === 429 || status === 503) {
    return 'busy';
  }
  if (status === 400 || status === 405 || status === 406 || status === 413) {
    return 'syntax';
  }
  return 'internal';
}

/** `index_not_found_exception: no such index [x]`, from the body when it says. */
export function failureText(response: ElasticResponse): string {
  try {
    const body = JSON.parse(response.body) as {
      error?:
        | { type?: unknown; reason?: unknown; root_cause?: { type?: unknown; reason?: unknown }[] }
        | string;
    };
    const error = body.error;
    if (typeof error === 'string') {
      return error;
    }
    const cause = error?.root_cause?.[0];
    const type = typeof cause?.type === 'string' ? cause.type : error?.type;
    const reason = typeof cause?.reason === 'string' ? cause.reason : error?.reason;
    if (typeof reason === 'string') {
      return typeof type === 'string' ? `${type}: ${reason}` : reason;
    }
  } catch {
    // Not JSON (a proxy's page, HEAD): the status says it.
  }
  return response.body.trim() === ''
    ? `HTTP ${response.status}`
    : `HTTP ${response.status}: ${response.body.trim().slice(0, 300)}`;
}

export function elasticFailure(response: ElasticResponse): DbError {
  return new DbError(statusKind(response.status), failureText(response), {
    driverCode: response.status,
  });
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** A failed link: refused, reset, timed out, or TLS spoken to a plain port. */
export function networkFailure(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message = errorMessage(error);
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO') {
    return new DbError(
      'connection-failed',
      `TLS failed: the server may not speak TLS on this port (${message})`,
      {
        cause: error,
        driverCode: code,
      },
    );
  }
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return new DbError('connection-failed', message, { cause: error, driverCode: code });
  }
  if (/socket hang up|socket closed/i.test(message)) {
    return new DbError('connection-failed', message, { cause: error });
  }
  return new DbError('internal', message, { cause: error });
}

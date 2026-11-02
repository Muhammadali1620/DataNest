// The management API answers a failure with an HTTP status and, usually, a JSON body such
// as `{"error":"not_found","reason":"Object Not Found"}`. The status says what kind of
// failure it is; the reason says what exactly. Network failures carry Node's codes and are
// the same as for any HTTP driver.

import { DbError, type DbErrorCode } from '../../core/errors';
import { networkFailure } from '../elasticsearch/errors';

export { networkFailure };

export function statusKind(status: number): DbErrorCode {
  switch (status) {
    case 401:
      return 'auth-failed';
    case 403:
      return 'permission-denied';
    case 404:
      return 'not-found';
    case 408:
    case 504:
      return 'timeout';
    case 409:
    case 412:
      return 'constraint';
    case 429:
    case 503:
      return 'busy';
    default:
      return status >= 400 && status < 500 ? 'syntax' : 'internal';
  }
}

/** The text a failed answer carries: the broker's reason, else the body, else the status. */
export function failureText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
    if (typeof parsed.reason === 'string' && parsed.reason !== '') {
      return typeof parsed.error === 'string' && parsed.error !== ''
        ? `${parsed.error}: ${parsed.reason}`
        : parsed.reason;
    }
    if (typeof parsed.error === 'string' && parsed.error !== '') {
      return parsed.error;
    }
  } catch {
    // Not JSON (a proxy's page): the status says it.
  }
  const trimmed = body.trim();
  return trimmed === '' ? `HTTP ${status}` : `HTTP ${status}: ${trimmed.slice(0, 300)}`;
}

export function rabbitFailure(status: number, body: string): DbError {
  return new DbError(statusKind(status), failureText(status, body), { driverCode: status });
}

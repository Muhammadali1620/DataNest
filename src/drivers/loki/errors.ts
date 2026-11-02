import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';

/** What the words of a Loki error say about its kind (it answers with plain text). */
function classify(text: string): DbErrorCode {
  const lower = text.toLowerCase();
  if (lower.includes('parse error') || lower.includes('syntax error')) {
    return 'syntax';
  }
  if (
    lower.includes('deadline exceeded') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return 'timeout';
  }
  if (lower.includes('canceled') || lower.includes('cancelled')) {
    return 'cancelled';
  }
  if (lower.includes('limit') || lower.includes('too many') || lower.includes('exceeds')) {
    return 'unsupported';
  }
  return 'internal';
}

/** The text of an error answer: Loki sends plain text, a gateway may send JSON or a page. */
function messageOf(body: string): string | undefined {
  const text = body.trim();
  if (text === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['message', 'error']) {
        if (typeof record[key] === 'string') {
          return record[key];
        }
      }
    }
  } catch {
    // Not JSON: Loki's own words are shown as they are.
  }
  return text.slice(0, 800);
}

/** A failure the server answered with a status of 400 or more. */
export function fromHttpStatus(status: number, body: string): DbError {
  const message = messageOf(body);
  if (status === 401) {
    return new DbError('auth-failed', message ?? msg('The server refused the user or the token'), {
      driverCode: status,
    });
  }
  if (status === 403) {
    return new DbError('permission-denied', message ?? msg('This user may not do this'), {
      driverCode: status,
    });
  }
  const text = message ?? msg('The server answered with HTTP status {0}', String(status));
  if (status === 404) {
    return new DbError('not-found', text, { driverCode: status });
  }
  if (status === 429) {
    return new DbError('unsupported', text, { driverCode: status });
  }
  if (status === 503 || status === 502 || status === 504) {
    return new DbError(status === 504 ? 'timeout' : 'connection-failed', text, {
      driverCode: status,
    });
  }
  if (status >= 500) {
    return new DbError(classify(text) === 'timeout' ? 'timeout' : 'internal', text, {
      driverCode: status,
    });
  }
  return new DbError(classify(text) === 'internal' ? 'syntax' : classify(text), text, {
    driverCode: status,
  });
}

/** A failure of the network itself (refused, reset, unreachable, timed out). */
export function toLokiError(error: unknown): DbError {
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

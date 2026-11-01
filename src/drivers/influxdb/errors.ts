import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';

/** What the text of a failed query says about its kind: Flux and InfluxQL word it their own way. */
function classify(text: string): DbErrorCode {
  const lower = text.toLowerCase();
  if (
    lower.includes('compilation failed') ||
    lower.includes('error parsing query') ||
    lower.includes('syntax error') ||
    lower.includes('found ') ||
    lower.includes('expected ')
  ) {
    return 'syntax';
  }
  if (lower.includes('not found') || lower.includes('database not found')) {
    return 'not-found';
  }
  if (lower.includes('unauthorized') || lower.includes('authorization')) {
    return 'auth-failed';
  }
  if (lower.includes('forbidden') || lower.includes('permission')) {
    return 'permission-denied';
  }
  if (lower.includes('timeout') || lower.includes('deadline exceeded')) {
    return 'timeout';
  }
  if (lower.includes('canceled') || lower.includes('cancelled')) {
    return 'cancelled';
  }
  return 'internal';
}

/** The `message` of an API error, or the `error` of a v1 answer, from a body that may be anything. */
function messageOf(body: string): { message?: string; code?: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const message =
        typeof record.message === 'string'
          ? record.message
          : typeof record.error === 'string'
            ? record.error
            : undefined;
      return {
        ...(message === undefined ? {} : { message }),
        ...(typeof record.code === 'string' ? { code: record.code } : {}),
      };
    }
  } catch {
    // Not JSON: a proxy or a plain page; its words are shown as they are.
  }
  const text = body.trim().slice(0, 500);
  return text === '' ? {} : { message: text };
}

/** A failure the server answered with a status of 400 or more. */
export function fromHttpStatus(status: number, body: string): DbError {
  const { message, code } = messageOf(body);
  if (status === 401) {
    return new DbError('auth-failed', message ?? msg('The server refused the API token'), {
      driverCode: status,
    });
  }
  if (status === 403) {
    return new DbError('permission-denied', message ?? msg('The token has no right to do this'), {
      driverCode: status,
    });
  }
  const text = message ?? msg('The server answered with HTTP status {0}', String(status));
  if (status === 404) {
    return new DbError('not-found', text, { driverCode: status });
  }
  if (status >= 500) {
    return new DbError(status === 503 ? 'connection-failed' : 'internal', text, {
      driverCode: status,
    });
  }
  return new DbError(classify(`${code ?? ''} ${text}`), text, { driverCode: code ?? status });
}

/** A failed query inside an answer that began well: the text, and the code Flux gives it. */
export function fluxQueryError(message: string, code: string | undefined): DbError {
  const text = message === '' ? msg('The query failed on the server') : message;
  return new DbError(
    classify(text),
    text,
    code === undefined || code === '' ? {} : { driverCode: code },
  );
}

/** An error the v1 API put in a chunk of an answer. */
export function influxqlError(message: string): DbError {
  return new DbError(classify(message), message);
}

/** A failure of the network itself (refused, reset, unreachable, timed out). */
export function toInfluxDbError(error: unknown): DbError {
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

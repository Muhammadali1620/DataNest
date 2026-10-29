// Redis error replies start with a code word (`WRONGTYPE`, `NOPERM`, `ERR`); network
// failures carry Node's codes. Both become the one error type the app understands.

import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';

// A Map, not an object literal: a word like `toString` must find nothing.
const BY_PREFIX: ReadonlyMap<string, DbErrorCode> = new Map([
  ['WRONGPASS', 'auth-failed'],
  ['NOAUTH', 'auth-failed'],
  ['NOPERM', 'permission-denied'],
  // A replica refuses writes.
  ['READONLY', 'permission-denied'],
  ['WRONGTYPE', 'constraint'],
  ['EXECABORT', 'constraint'],
  ['BUSYKEY', 'constraint'],
  ['OOM', 'constraint'],
  ['CROSSSLOT', 'constraint'],
  ['NOGROUP', 'not-found'],
  ['NOSCRIPT', 'not-found'],
  ['BUSY', 'busy'],
  ['LOADING', 'busy'],
  ['TRYAGAIN', 'busy'],
  ['MASTERDOWN', 'busy'],
  ['CLUSTERDOWN', 'busy'],
]);

/** `ERR …` texts that say more than the generic prefix. */
const ERR_TEXTS: readonly (readonly [RegExp, DbErrorCode])[] = [
  [/^ERR (unknown command|unknown subcommand|wrong number of arguments|syntax error)/i, 'syntax'],
  [/^ERR (no such key|DB index is out of range|invalid DB index)/i, 'not-found'],
  [/^ERR .*(not an integer|out of range|not a valid float|is not a float|overflow)/i, 'constraint'],
  [/^ERR .*(AUTH|password)/i, 'auth-failed'],
];

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ECONNABORTED',
  'ETIMEDOUT',
]);

/** Texts of ioredis that mean the link is gone or never came up. */
const LINK_TEXTS =
  /Connection is closed|Stream isn't writeable|connect ETIMEDOUT|All sentinels are unreachable|Failed to refresh slots cache|None of startup nodes is available|Connection in subscriber mode/i;

/** The error reply's code word, e.g. `WRONGTYPE`; undefined for other errors. */
export function replyCode(message: string): string | undefined {
  return /^([A-Z][A-Z_-]*)\b/.exec(message)?.[1];
}

/** True for an error the server sent as a reply (`-ERR …`), not a broken link. */
export function isReplyError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ReplyError';
}

export function toRedisDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const message = errorMessage(error);
  const nodeCode = (error as { code?: unknown } | null)?.code;
  if (typeof nodeCode === 'string' && NETWORK_CODES.has(nodeCode)) {
    return new DbError('connection-failed', message, { cause: error, driverCode: nodeCode });
  }
  if (isReplyError(error)) {
    const code = replyCode(message);
    const mapped =
      (code === undefined ? undefined : BY_PREFIX.get(code)) ??
      ERR_TEXTS.find(([pattern]) => pattern.test(message))?.[1] ??
      'internal';
    return new DbError(mapped, message, {
      cause: error,
      ...(code === undefined ? {} : { driverCode: code }),
    });
  }
  if (LINK_TEXTS.test(message)) {
    return new DbError('connection-failed', message, { cause: error });
  }
  return new DbError('internal', message, { cause: error });
}

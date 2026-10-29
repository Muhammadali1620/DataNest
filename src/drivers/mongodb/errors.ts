// MongoDB errors carry a numeric code and its name (`11000 DuplicateKey`); network and
// server selection failures are classes of the driver. Both become the one error type
// the app understands (ARCHITECTURE.md §9).

import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';

// A Map, not an object literal: a number like `constructor` must find nothing.
const BY_CODE: ReadonlyMap<number, DbErrorCode> = new Map([
  [2, 'syntax'], // BadValue
  [9, 'syntax'], // FailedToParse
  [14, 'syntax'], // TypeMismatch
  [40, 'syntax'], // ConflictingUpdateOperators
  [52, 'syntax'], // DollarPrefixedFieldName
  [59, 'syntax'], // CommandNotFound
  [72, 'syntax'], // InvalidOptions
  [73, 'syntax'], // InvalidNamespace
  [15_974, 'syntax'], // Unrecognized pipeline stage
  [40_324, 'syntax'], // Unrecognized pipeline stage name
  [13, 'permission-denied'], // Unauthorized
  [18, 'auth-failed'], // AuthenticationFailed
  [11_000, 'constraint'], // DuplicateKey
  [11_001, 'constraint'],
  [121, 'constraint'], // DocumentValidationFailure
  [48, 'constraint'], // NamespaceExists
  [66, 'constraint'], // ImmutableField
  [67, 'constraint'], // CannotCreateIndex
  [85, 'constraint'], // IndexOptionsConflict
  [86, 'constraint'], // IndexKeySpecsConflict
  [10_334, 'constraint'], // BSONObjectTooLarge
  [17_280, 'constraint'], // KeyTooLong
  [26, 'not-found'], // NamespaceNotFound
  [27, 'not-found'], // IndexNotFound
  [50, 'timeout'], // MaxTimeMSExpired
  [262, 'timeout'], // ExceededTimeLimit
  [11_601, 'cancelled'], // Interrupted
  [112, 'busy'], // WriteConflict
  [189, 'busy'], // PrimarySteppedDown
  [10_107, 'busy'], // NotWritablePrimary
  [13_435, 'busy'], // NotPrimaryNoSecondaryOk
  [11_600, 'busy'], // InterruptedAtShutdown
  [11_602, 'busy'], // InterruptedDueToReplStateChange
  [91, 'busy'], // ShutdownInProgress
  [166, 'unsupported'], // CommandNotSupportedOnView
  [115, 'unsupported'], // CommandNotSupported
  [20, 'unsupported'], // IllegalOperation
]);

/** Classes of the driver that mean the link is gone or never came up. */
const LINK_ERRORS = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoTopologyClosedError',
  'MongoServerClosedError',
  'PoolClosedError',
  'PoolClearedError',
  'PoolClearedOnNetworkError',
  'MongoNotConnectedError',
]);

interface DriverError {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly codeName?: unknown;
  readonly reason?: unknown;
  readonly cause?: unknown;
}

/**
 * The text to show. A refused command repeats itself in full (`not authorized on shop to
 * execute command { insert: …, documents: [ … ] }`), user data included: only its name stays.
 */
export function shortMessage(message: string): string {
  const refused = /^(not authorized on \S+ to execute command) \{ ?"?(\w+)/.exec(message);
  return refused === null ? message : `${refused[1]} ${refused[2]}`;
}

/**
 * Why server selection gave up: the driver says "Server selection timed out after
 * 10000 ms", while the server it tried has the real reason (refused, wrong password).
 */
function selectionReason(error: DriverError): unknown {
  const servers = (error.reason as { servers?: unknown } | undefined)?.servers;
  if (!(servers instanceof Map)) {
    return undefined;
  }
  for (const server of servers.values() as Iterable<{ error?: unknown }>) {
    if (server.error !== undefined && server.error !== null) {
      return server.error;
    }
  }
  return undefined;
}

/**
 * The server's error code. A command read with `promoteValues: false` gets it as an
 * Int32 object instead of a number.
 */
function numericCode(code: unknown): number | undefined {
  if (typeof code === 'number') {
    return code;
  }
  const value = (code as { value?: unknown } | null | undefined)?.value;
  return typeof code === 'object' && typeof value === 'number' ? value : undefined;
}

export function toMongoDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const driver = (typeof error === 'object' && error !== null ? error : {}) as DriverError;
  const name = typeof driver.name === 'string' ? driver.name : '';
  const code = numericCode(driver.code);
  const codeName = typeof driver.codeName === 'string' ? driver.codeName : undefined;
  if (name === 'MongoServerSelectionError') {
    const reason = selectionReason(driver);
    if (reason !== undefined) {
      const inner = toMongoDbError(reason);
      // A wrong password stays a wrong password, not a lost link.
      const kept = inner.code === 'auth-failed' || inner.code === 'permission-denied';
      return new DbError(kept ? inner.code : 'connection-failed', inner.message, {
        cause: error,
        ...(inner.driverCode === undefined ? {} : { driverCode: inner.driverCode }),
      });
    }
  }
  const message = shortMessage(errorMessage(error));
  const mapped = code === undefined ? undefined : BY_CODE.get(code);
  if (mapped !== undefined) {
    return new DbError(mapped, message, { cause: error, driverCode: codeName ?? code });
  }
  if (
    LINK_ERRORS.has(name) ||
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH/.test(message)
  ) {
    return new DbError('connection-failed', message, {
      cause: error,
      ...(typeof driver.code === 'string' ? { driverCode: driver.code } : {}),
    });
  }
  if (name === 'MongoParseError' || name === 'MongoInvalidArgumentError') {
    return new DbError('syntax', message, { cause: error });
  }
  if (/Authentication failed|auth error|SCRAM/i.test(message)) {
    return new DbError('auth-failed', message, { cause: error });
  }
  return new DbError('internal', message, {
    cause: error,
    ...(code === undefined ? {} : { driverCode: codeName ?? code }),
  });
}

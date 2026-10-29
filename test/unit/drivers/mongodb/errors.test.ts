import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { shortMessage, toMongoDbError } from '../../../../src/drivers/mongodb/errors';

/** An error shaped like the driver's own classes. */
function driverError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name, ...extra });
}

describe('toMongoDbError (V7.5)', () => {
  it.each([
    [11_000, 'DuplicateKey', 'constraint'],
    [121, 'DocumentValidationFailure', 'constraint'],
    [13, 'Unauthorized', 'permission-denied'],
    [18, 'AuthenticationFailed', 'auth-failed'],
    [26, 'NamespaceNotFound', 'not-found'],
    [27, 'IndexNotFound', 'not-found'],
    [50, 'MaxTimeMSExpired', 'timeout'],
    [59, 'CommandNotFound', 'syntax'],
    [2, 'BadValue', 'syntax'],
    [10_107, 'NotWritablePrimary', 'busy'],
    [166, 'CommandNotSupportedOnView', 'unsupported'],
    [11_601, 'Interrupted', 'cancelled'],
  ])('maps server code %i (%s) to %s', (code, codeName, expected) => {
    const mapped = toMongoDbError(driverError('MongoServerError', 'x', { code, codeName }));
    expect(mapped.code).toBe(expected);
    expect(mapped.driverCode).toBe(codeName);
  });

  it('reads a code the driver kept as an Int32 object (promoteValues: false)', () => {
    const mapped = toMongoDbError(
      driverError('MongoServerError', "no such command: 'x'", { code: { value: 59 } }),
    );
    expect(mapped.code).toBe('syntax');
  });

  it('takes the reason of a failed server selection from the server it tried', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    const selection = driverError(
      'MongoServerSelectionError',
      'Server selection timed out after 3000 ms',
      {
        reason: {
          servers: new Map([
            [
              '127.0.0.1:1',
              { error: driverError('MongoNetworkError', refused.message, { cause: refused }) },
            ],
          ]),
        },
      },
    );
    const mapped = toMongoDbError(selection);
    expect(mapped).toMatchObject({
      code: 'connection-failed',
      message: 'connect ECONNREFUSED 127.0.0.1:1',
    });
  });

  it('keeps a wrong password a wrong password when selection hid it', () => {
    const auth = driverError('MongoServerError', 'Authentication failed.', {
      code: 18,
      codeName: 'AuthenticationFailed',
    });
    const selection = driverError('MongoServerSelectionError', 'timed out', {
      reason: { servers: new Map([['h', { error: auth }]]) },
    });
    expect(toMongoDbError(selection).code).toBe('auth-failed');
  });

  it('calls a selection failure without a reason a lost connection', () => {
    expect(
      toMongoDbError(driverError('MongoServerSelectionError', 'timed out', { reason: {} })).code,
    ).toBe('connection-failed');
  });

  it.each([
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoTopologyClosedError',
    'PoolClearedError',
  ])('calls %s a lost connection', (name) => {
    expect(toMongoDbError(driverError(name, 'gone')).code).toBe('connection-failed');
  });

  it('recognizes network failures by their text', () => {
    expect(toMongoDbError(new Error('getaddrinfo ENOTFOUND nowhere')).code).toBe(
      'connection-failed',
    );
  });

  it('calls a bad URL or option a syntax error', () => {
    expect(toMongoDbError(driverError('MongoParseError', 'bad option')).code).toBe('syntax');
    expect(toMongoDbError(driverError('MongoInvalidArgumentError', 'bad')).code).toBe('syntax');
  });

  it('recognizes a failed sign-in by its text', () => {
    expect(toMongoDbError(new Error('SCRAM failure')).code).toBe('auth-failed');
  });

  it('keeps a DbError and falls back to internal', () => {
    const own = new DbError('busy', 'x');
    expect(toMongoDbError(own)).toBe(own);
    expect(toMongoDbError(driverError('MongoServerError', 'odd', { code: 99_999 }))).toMatchObject({
      code: 'internal',
      driverCode: 99_999,
    });
    expect(toMongoDbError('text').code).toBe('internal');
  });
});

describe('shortMessage (V7.5)', () => {
  it('drops the command a refusal repeats, with the user data in it', () => {
    expect(
      shortMessage(
        'not authorized on shop to execute command { insert: "x", documents: [ { secret: 1 } ] }',
      ),
    ).toBe('not authorized on shop to execute command insert');
  });

  it('leaves other messages alone', () => {
    expect(shortMessage('E11000 duplicate key error')).toBe('E11000 duplicate key error');
  });
});

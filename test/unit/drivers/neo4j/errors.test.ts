import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  fromHttpStatus,
  fromNeo4jError,
  toNeo4jDbError,
} from '../../../../src/drivers/neo4j/errors';

describe('fromNeo4jError', () => {
  it.each([
    ['Neo.ClientError.Security.Unauthorized', 'auth-failed'],
    ['Neo.ClientError.Security.AuthenticationRateLimit', 'auth-failed'],
    ['Neo.ClientError.Security.Forbidden', 'permission-denied'],
    ['Neo.ClientError.Security.AuthorizationFailed', 'permission-denied'],
    ['Neo.ClientError.Statement.SyntaxError', 'syntax'],
    ['Neo.ClientError.Statement.ParameterMissing', 'syntax'],
    ['Neo.ClientError.Statement.TypeError', 'syntax'],
    ['Neo.ClientError.Request.Invalid', 'syntax'],
    ['Neo.ClientError.Statement.AccessMode', 'permission-denied'],
    ['Neo.ClientError.Database.DatabaseNotFound', 'not-found'],
    ['Neo.ClientError.Statement.EntityNotFound', 'not-found'],
    ['Neo.ClientError.Transaction.TransactionTimedOut', 'timeout'],
    ['Neo.TransientError.Transaction.DeadlockDetected', 'timeout'],
    ['Neo.ClientError.Schema.ConstraintValidationFailed', 'constraint'],
    ['Neo.DatabaseError.General.UnknownError', 'internal'],
  ])('maps %s to %s', (code, expected) => {
    const error = fromNeo4jError({ code, message: 'text' });
    expect(error.code).toBe(expected);
    expect(error.message).toBe('text');
    expect(error.driverCode).toBe(code);
  });

  it('names a Schema error that is not about a constraint plainly', () => {
    expect(
      fromNeo4jError({ code: 'Neo.ClientError.Schema.IndexNotFound', message: 'no index' }).code,
    ).toBe('internal');
  });

  it('copes with an error that says nothing', () => {
    expect(fromNeo4jError({}).message).toBe('The server reported an error without a message');
    expect(fromNeo4jError({ code: 'Neo.X' }).message).toBe('Neo.X');
    expect(fromNeo4jError({ code: 5, message: '' }).code).toBe('internal');
  });
});

describe('fromHttpStatus', () => {
  const body = (code: string, message: string): string =>
    JSON.stringify({ errors: [{ code, message }] });

  it('trusts the code the server gave', () => {
    expect(fromHttpStatus(400, body('Neo.ClientError.Statement.SyntaxError', 'bad')).code).toBe(
      'syntax',
    );
    expect(
      fromHttpStatus(404, body('Neo.ClientError.Database.DatabaseNotFound', 'no db')).code,
    ).toBe('not-found');
    expect(fromHttpStatus(401, body('Neo.ClientError.Security.Unauthorized', 'no')).code).toBe(
      'auth-failed',
    );
  });

  it('knows a refused sign-in without a body', () => {
    expect(fromHttpStatus(401, '').code).toBe('auth-failed');
    expect(fromHttpStatus(403, 'nope').code).toBe('auth-failed');
  });

  it('says that an old server has no Query API', () => {
    const error = fromHttpStatus(404, '<html>not found</html>');
    expect(error.code).toBe('connection-failed');
    expect(error.message).toMatch(/5\.19/u);
  });

  it('treats a server fault as a lost connection and a bad request as a plain fault', () => {
    expect(fromHttpStatus(503, '').code).toBe('connection-failed');
    expect(fromHttpStatus(500, body('Neo.DatabaseError.General.UnknownError', 'boom')).code).toBe(
      'connection-failed',
    );
    expect(
      fromHttpStatus(500, body('Neo.DatabaseError.General.UnknownError', 'boom')).message,
    ).toBe('boom');
    expect(fromHttpStatus(418, 'teapot').code).toBe('internal');
    expect(fromHttpStatus(418, 'teapot').message).toMatch(/418/u);
  });

  it('ignores a body that is not the shape it expects', () => {
    expect(fromHttpStatus(500, JSON.stringify({ errors: 'x' })).code).toBe('connection-failed');
    expect(fromHttpStatus(500, JSON.stringify({ errors: [] })).code).toBe('connection-failed');
  });
});

describe('toNeo4jDbError', () => {
  it('passes a DbError through', () => {
    const error = new DbError('cancelled', 'stop');
    expect(toNeo4jDbError(error)).toBe(error);
  });

  it('calls a network failure a lost connection', () => {
    const error = toNeo4jDbError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    expect(error.code).toBe('connection-failed');
    expect(error.driverCode).toBe('ECONNREFUSED');
    expect(
      toNeo4jDbError(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).code,
    ).toBe('connection-failed');
  });

  it('keeps anything else as an internal error', () => {
    expect(toNeo4jDbError(new Error('boom')).code).toBe('internal');
    expect(toNeo4jDbError('text').code).toBe('internal');
  });
});

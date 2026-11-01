import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  fromHranaError,
  fromHttpStatus,
  toLibsqlDbError,
} from '../../../../src/drivers/libsql/errors';

describe('fromHranaError', () => {
  it.each([
    ['SQLITE_CONSTRAINT', 'constraint'],
    ['SQLITE_CONSTRAINT_PRIMARYKEY', 'constraint'],
    ['SQLITE_TOOBIG', 'constraint'],
    ['SQLITE_READONLY', 'permission-denied'],
    ['SQLITE_READONLY_DBMOVED', 'permission-denied'],
    ['SQLITE_AUTH', 'permission-denied'],
    ['SQLITE_PERM', 'permission-denied'],
    ['SQLITE_BUSY', 'timeout'],
    ['SQLITE_LOCKED', 'timeout'],
    ['SQLITE_INTERRUPT', 'cancelled'],
    ['SQL_PARSE_ERROR', 'syntax'],
    ['SQL_INPUT_ERROR', 'syntax'],
    ['AUTH_REQUIRED', 'auth-failed'],
    ['AUTH_FAILED', 'auth-failed'],
    ['AUTH_JWT_EXPIRED', 'auth-failed'],
    ['SOMETHING_NEW', 'internal'],
  ])('maps %s to %s', (code, expected) => {
    const error = fromHranaError({ code, message: 'm' });
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe(expected);
    expect(error.message).toBe('m');
    expect(error.driverCode).toBe(code);
  });

  it('tells the kinds of a plain SQLITE_ERROR apart by its text', () => {
    const code = 'SQLITE_ERROR';
    expect(fromHranaError({ code, message: 'no such table: t' }).code).toBe('not-found');
    expect(fromHranaError({ code, message: 'no such column: c' }).code).toBe('not-found');
    expect(fromHranaError({ code, message: 'no such index: i' }).code).toBe('not-found');
    expect(fromHranaError({ code, message: 'no such function: f' }).code).toBe('not-found');
    expect(fromHranaError({ code, message: 'near "x": syntax error' }).code).toBe('syntax');
    expect(fromHranaError({ code, message: 'unrecognized token: "@"' }).code).toBe('syntax');
    expect(fromHranaError({ code, message: 'table t already exists' }).code).toBe('constraint');
    expect(fromHranaError({ code, message: 'attempt to write a readonly database' }).code).toBe(
      'permission-denied',
    );
    expect(fromHranaError({ code, message: 'something odd' }).code).toBe('internal');
  });

  it('reads the text when the server sends no code', () => {
    const error = fromHranaError({ message: 'no such table: t' });
    expect(error.code).toBe('not-found');
    expect(error.driverCode).toBeUndefined();
  });

  it('survives an error with neither a code nor a message', () => {
    expect(fromHranaError({}).message).not.toBe('');
    expect(fromHranaError({ message: 5, code: 6 }).message).not.toBe('');
    expect(fromHranaError({ code: 'SQLITE_BUSY', message: '' }).message).toBe('SQLITE_BUSY');
  });
});

describe('fromHttpStatus', () => {
  it('reads a refused token from 401 and 403, with the server text when it has one', () => {
    for (const status of [401, 403]) {
      const error = fromHttpStatus(status, JSON.stringify({ message: 'Authorization failed' }));
      expect(error.code).toBe('auth-failed');
      expect(error.message).toBe('Authorization failed');
      expect(error.driverCode).toBe(status);
    }
    expect(fromHttpStatus(401, '').code).toBe('auth-failed');
    expect(fromHttpStatus(401, '').message).not.toBe('');
    expect(fromHttpStatus(403, 'denied').message).toBe('denied');
  });

  it('uses the Hrana code of a JSON body', () => {
    const error = fromHttpStatus(400, JSON.stringify({ message: 'bad', code: 'SQL_PARSE_ERROR' }));
    expect(error.code).toBe('syntax');
  });

  it('shows a text body as the message', () => {
    const error = fromHttpStatus(400, 'Received an invalid baton');
    expect(error.code).toBe('internal');
    expect(error.message).toBe('Received an invalid baton');
    expect(error.driverCode).toBe(400);
  });

  it('calls a server fault a failed connection and names an empty answer by its status', () => {
    expect(fromHttpStatus(502, '').code).toBe('connection-failed');
    expect(fromHttpStatus(502, '').message).toContain('502');
    expect(fromHttpStatus(404, '').code).toBe('internal');
  });

  it('cuts a long text body', () => {
    expect(fromHttpStatus(400, 'x'.repeat(2000)).message.length).toBeLessThanOrEqual(500);
  });

  it('ignores a JSON body that is not an object', () => {
    expect(fromHttpStatus(400, '123').message).toContain('400');
    expect(fromHttpStatus(400, 'null').message).toContain('400');
  });
});

describe('toLibsqlDbError', () => {
  it('passes a DbError on', () => {
    const error = new DbError('cancelled', 'c');
    expect(toLibsqlDbError(error)).toBe(error);
  });

  it('calls a network failure a failed connection, keeping its code', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    const mapped = toLibsqlDbError(refused);
    expect(mapped.code).toBe('connection-failed');
    expect(mapped.driverCode).toBe('ECONNREFUSED');
    expect(
      toLibsqlDbError(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME' })).code,
    ).toBe('connection-failed');
  });

  it('calls anything else internal', () => {
    expect(toLibsqlDbError(new Error('boom')).code).toBe('internal');
    expect(toLibsqlDbError('text').code).toBe('internal');
    expect(toLibsqlDbError(null).code).toBe('internal');
    expect(toLibsqlDbError(Object.assign(new Error('x'), { code: 23 })).code).toBe('internal');
  });
});

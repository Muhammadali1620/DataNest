import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  etcdFailure,
  failureText,
  grpcKind,
  isTokenRefusal,
  networkFailure,
} from '../../../../src/drivers/etcd/errors';

describe('grpcKind', () => {
  it('names what the gRPC code stands for', () => {
    expect(grpcKind(3, 400)).toBe('syntax');
    expect(grpcKind(4, 504)).toBe('timeout');
    expect(grpcKind(5, 404)).toBe('not-found');
    expect(grpcKind(6, 409)).toBe('constraint');
    expect(grpcKind(8, 429)).toBe('constraint');
    expect(grpcKind(9, 400)).toBe('constraint');
    expect(grpcKind(10, 409)).toBe('constraint');
    expect(grpcKind(7, 403)).toBe('permission-denied');
    expect(grpcKind(14, 503)).toBe('busy');
    expect(grpcKind(16, 401)).toBe('auth-failed');
  });

  it('falls back to the HTTP status when the code says nothing', () => {
    expect(grpcKind(undefined, 401)).toBe('auth-failed');
    expect(grpcKind(undefined, 403)).toBe('permission-denied');
    expect(grpcKind(undefined, 404)).toBe('not-found');
    expect(grpcKind(undefined, 408)).toBe('timeout');
    expect(grpcKind(undefined, 504)).toBe('timeout');
    expect(grpcKind(undefined, 429)).toBe('busy');
    expect(grpcKind(undefined, 503)).toBe('busy');
    expect(grpcKind(undefined, 400)).toBe('syntax');
    expect(grpcKind(undefined, 500)).toBe('internal');
    expect(grpcKind(2, 500)).toBe('internal');
  });
});

describe('failureText', () => {
  it('prefers the gateway message', () => {
    expect(
      failureText(400, '{"error":"e","code":3,"message":"etcdserver: key is not provided"}'),
    ).toEqual({
      code: 3,
      text: 'etcdserver: key is not provided',
    });
  });

  it('reads an error field when there is no message', () => {
    expect(failureText(400, '{"error":"only error"}')).toEqual({ text: 'only error' });
  });

  it('says the status for a body that is not JSON or says nothing', () => {
    expect(failureText(502, '').text).toBe('HTTP 502');
    expect(failureText(502, '<html>bad gateway</html>').text).toBe(
      'HTTP 502: <html>bad gateway</html>',
    );
    expect(failureText(500, '{}').text).toBe('HTTP 500: {}');
    expect(failureText(500, 'x'.repeat(1000)).text.length).toBeLessThan(330);
  });
});

describe('etcdFailure and isTokenRefusal', () => {
  it('builds an error of the right kind with the code kept', () => {
    const error = etcdFailure(401, '{"code":16,"message":"etcdserver: invalid auth token"}');
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe('auth-failed');
    expect(error.driverCode).toBe(16);
    expect(isTokenRefusal(error)).toBe(true);
  });

  it('recognises only a refused token, not every sign-in failure', () => {
    expect(
      isTokenRefusal(etcdFailure(401, '{"code":16,"message":"etcdserver: invalid auth token"}')),
    ).toBe(true);
    expect(
      isTokenRefusal(
        etcdFailure(
          400,
          '{"code":3,"message":"etcdserver: authentication failed, invalid user ID or password"}',
        ),
      ),
    ).toBe(false);
    expect(isTokenRefusal(new DbError('internal', 'invalid auth token'))).toBe(false);
    expect(isTokenRefusal(new Error('invalid auth token'))).toBe(false);
  });

  it('keeps the HTTP status as the code of an error with no gRPC code', () => {
    expect(etcdFailure(502, 'bad').driverCode).toBe(502);
  });
});

describe('networkFailure', () => {
  it('is the same as the other HTTP drivers have', () => {
    expect(networkFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).code).toBe(
      'connection-failed',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { toCassandraDbError } from '../../../../src/drivers/cassandra/errors';
import { driverError } from '../../../helpers/fake-cassandra';

describe('toCassandraDbError', () => {
  it('passes a DbError on', () => {
    const own = new DbError('timeout', 'slow');
    expect(toCassandraDbError(own)).toBe(own);
  });

  it.each([
    [0x0100, 'auth-failed'],
    [0x1000, 'connection-failed'],
    [0x1001, 'connection-failed'],
    [0x1002, 'connection-failed'],
    [0x1100, 'timeout'],
    [0x1200, 'timeout'],
    [0x2000, 'syntax'],
    [0x2100, 'permission-denied'],
    [0x2400, 'constraint'],
    [0x0000, 'internal'],
    [0x2500, 'internal'],
  ])('maps the protocol code %i to %s', (code, expected) => {
    const mapped = toCassandraDbError(driverError('ResponseError', 'server said so', code));
    expect(mapped.code).toBe(expected);
    expect(mapped.driverCode).toBe(code);
    expect(mapped.message).toBe('server said so');
  });

  it('tells a missing keyspace or table from a bad statement, among "invalid" errors', () => {
    expect(
      toCassandraDbError(driverError('ResponseError', 'unconfigured table nope', 0x2200)).code,
    ).toBe('not-found');
    expect(
      toCassandraDbError(driverError('ResponseError', "Keyspace 'x' does not exist", 0x2200)).code,
    ).toBe('not-found');
    expect(
      toCassandraDbError(driverError('ResponseError', 'Undefined column name zz', 0x2200)).code,
    ).toBe('syntax');
    expect(toCassandraDbError(driverError('ResponseError', 'bad config', 0x2300)).code).toBe(
      'syntax',
    );
  });

  it('says a refused sign-in when the nodes answered "bad credentials"', () => {
    const error = Object.assign(driverError('NoHostAvailableError', 'All hosts failed'), {
      innerErrors: { '127.0.0.1:9042': driverError('AuthenticationError', 'Bad credentials') },
    });
    expect(toCassandraDbError(error).code).toBe('auth-failed');
    const byCode = Object.assign(driverError('NoHostAvailableError', 'All hosts failed'), {
      innerErrors: { a: driverError('ResponseError', 'x', 0x0100) },
    });
    expect(toCassandraDbError(byCode).code).toBe('auth-failed');
  });

  it('names why no node could be reached', () => {
    const error = Object.assign(driverError('NoHostAvailableError', 'All hosts failed'), {
      innerErrors: { '127.0.0.1:9042': new Error('connect ECONNREFUSED 127.0.0.1:9042') },
    });
    const mapped = toCassandraDbError(error);
    expect(mapped.code).toBe('connection-failed');
    expect(mapped.message).toContain('ECONNREFUSED');
    expect(toCassandraDbError(driverError('NoHostAvailableError', 'x')).message).toMatch(
      /No Cassandra node/u,
    );
  });

  it('maps timeouts, argument errors and network codes', () => {
    expect(toCassandraDbError(driverError('OperationTimedOutError', 'late')).code).toBe('timeout');
    expect(toCassandraDbError(driverError('ArgumentError', 'bad parameter')).code).toBe('syntax');
    expect(toCassandraDbError(driverError('AuthenticationError', 'no')).code).toBe('auth-failed');
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(toCassandraDbError(reset)).toMatchObject({
      code: 'connection-failed',
      driverCode: 'ECONNRESET',
    });
  });

  it('keeps the rest as internal errors, and accepts anything thrown', () => {
    expect(toCassandraDbError(new Error('odd')).code).toBe('internal');
    expect(toCassandraDbError('plain text').code).toBe('internal');
    expect(toCassandraDbError(undefined).code).toBe('internal');
  });
});

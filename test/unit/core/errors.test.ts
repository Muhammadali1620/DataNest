import { describe, expect, it, vi } from 'vitest';
import {
  DbError,
  describeError,
  errorMessage,
  isDbError,
  toDbError,
} from '../../../src/core/errors';

describe('DbError', () => {
  it('is an Error with a code and a message', () => {
    const error = new DbError('syntax', 'near "SELEC"');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DbError');
    expect(error.code).toBe('syntax');
    expect(error.message).toBe('near "SELEC"');
    expect(error.stack).toContain('DbError');
  });

  it('keeps all optional fields', () => {
    const cause = new Error('socket closed');
    const error = new DbError('constraint', 'Duplicate entry', {
      detail: 'Key (email)=(a@b.c) already exists.',
      position: 12,
      sqlState: '23505',
      driverCode: 'ER_DUP_ENTRY',
      cause,
    });
    expect(error).toMatchObject({
      detail: 'Key (email)=(a@b.c) already exists.',
      position: 12,
      sqlState: '23505',
      driverCode: 'ER_DUP_ENTRY',
    });
    expect(error.cause).toBe(cause);
  });

  it('leaves optional fields undefined when not given', () => {
    const error = new DbError('timeout', 'Query timed out');
    expect(error.detail).toBeUndefined();
    expect(error.position).toBeUndefined();
    expect(error.sqlState).toBeUndefined();
    expect(error.driverCode).toBeUndefined();
    expect('cause' in error).toBe(false);
  });

  it('accepts position 0 and numeric driver codes', () => {
    const error = new DbError('syntax', 'x', { position: 0, driverCode: 1064 });
    expect(error.position).toBe(0);
    expect(error.driverCode).toBe(1064);
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rejects the invalid position %s',
    (position) => {
      expect(() => new DbError('syntax', 'x', { position })).toThrow(RangeError);
    },
  );
});

describe('isDbError', () => {
  it('recognizes only DbError instances', () => {
    expect(isDbError(new DbError('internal', 'x'))).toBe(true);
    expect(isDbError(new Error('x'))).toBe(false);
    expect(isDbError({ code: 'internal', message: 'x' })).toBe(false);
    expect(isDbError(null)).toBe(false);
  });

  it('recognizes a DbError of another copy of the module, as a driver bundle throws it', async () => {
    vi.resetModules();
    const other = await import('../../../src/core/errors');
    expect(other.DbError).not.toBe(DbError);
    const foreign = new other.DbError('connection-failed', 'gone', { position: 3 });

    expect(foreign instanceof DbError).toBe(true);
    expect(isDbError(foreign)).toBe(true);
    // The code and fields survive instead of becoming a generic `internal` error.
    expect(toDbError(foreign)).toBe(foreign);
    expect(toDbError(foreign).code).toBe('connection-failed');
    expect(describeError(foreign)).toContain('DbError [connection-failed]: gone');
    expect(new DbError('internal', 'x') instanceof other.DbError).toBe(true);
  });

  it('is not fooled by objects that only look like one', () => {
    const fake = Object.assign(new Error('x'), { name: 'DbError', code: 'cancelled' });
    expect(isDbError(fake)).toBe(false);
    expect(toDbError(fake).code).toBe('internal');
  });
});

describe('toDbError', () => {
  it('returns a DbError unchanged', () => {
    const error = new DbError('auth-failed', 'Access denied');
    expect(toDbError(error)).toBe(error);
  });

  it('wraps an Error and keeps it as cause', () => {
    const original = new TypeError('boom');
    const wrapped = toDbError(original);
    expect(wrapped.code).toBe('internal');
    expect(wrapped.message).toBe('boom');
    expect(wrapped.cause).toBe(original);
  });

  it('uses the given fallback code', () => {
    expect(toDbError(new Error('ECONNREFUSED'), 'connection-failed').code).toBe(
      'connection-failed',
    );
  });

  it('wraps strings and unknown values', () => {
    expect(toDbError('plain text').message).toBe('plain text');
    expect(toDbError(42).message).toBe('Unexpected error');
    expect(toDbError(undefined).message).toBe('Unexpected error');
    expect(toDbError({ any: 'object' }).cause).toEqual({ any: 'object' });
  });
});

describe('errorMessage', () => {
  it('uses the message of an Error', () => {
    expect(errorMessage(new Error('Connection lost'))).toBe('Connection lost');
  });

  it('falls back to the name for an Error without message', () => {
    expect(errorMessage(new RangeError(''))).toBe('RangeError');
    expect(errorMessage(new Error('   '))).toBe('Error');
  });

  it('accepts a non-empty string', () => {
    expect(errorMessage('Something failed')).toBe('Something failed');
  });

  it.each([[''], ['  '], [null], [undefined], [0], [{}], [Symbol('x')]])(
    'gives a generic message for %s',
    (value) => {
      expect(errorMessage(value)).toBe('Unexpected error');
    },
  );
});

describe('describeError', () => {
  it('lists DbError fields and stack frames', () => {
    const text = describeError(
      new DbError('constraint', 'Duplicate', {
        sqlState: '23505',
        driverCode: 1062,
        position: 7,
        detail: 'Key exists',
      }),
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('DbError [constraint]: Duplicate');
    expect(lines.slice(1, 5)).toEqual([
      '  sqlState: 23505',
      '  driverCode: 1062',
      '  position: 7',
      '  detail: Key exists',
    ]);
    expect(lines.slice(5).every((line) => line.startsWith('  at '))).toBe(true);
    expect(lines.length).toBeGreaterThan(5);
  });

  it('skips missing DbError fields', () => {
    expect(describeError(new DbError('timeout', 'Slow')).split('\n')[1]).toMatch(/^ {2}at /);
  });

  it('follows the cause chain', () => {
    const root = new Error('ECONNRESET');
    const middle = new DbError('connection-failed', 'Lost connection', { cause: root });
    const top = new Error('Query failed', { cause: middle });
    const text = describeError(top);
    expect(text.indexOf('Error: Query failed')).toBe(0);
    expect(text).toContain('Caused by: DbError [connection-failed]: Lost connection');
    expect(text).toContain('Caused by: Error: ECONNRESET');
    expect(text.indexOf('Lost connection')).toBeLessThan(text.indexOf('ECONNRESET'));
  });

  it('stops on circular causes', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    const text = describeError(a);
    expect(text).toContain('Caused by: Error: b');
    expect(text.endsWith('[circular cause]')).toBe(true);
  });

  it('limits very deep cause chains', () => {
    let error = new Error('level 0');
    for (let i = 1; i <= 50; i++) {
      error = new Error(`level ${i}`, { cause: error });
    }
    expect(describeError(error).match(/Caused by:/g)).toHaveLength(9);
  });

  it('describes non-Error values', () => {
    expect(describeError('just text')).toBe('just text');
    expect(describeError({ code: 'X', n: 1 })).toBe('{"code":"X","n":1}');
    expect(describeError(null)).toBe('null');
    expect(describeError(() => 1)).toBe('() => 1');
  });

  it('does not crash on values JSON cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular)).toBe('[object Object]');
    expect(describeError(10n)).toBe('[object BigInt]');
  });

  it('handles errors without a stack', () => {
    const error = new Error('no stack');
    delete error.stack;
    expect(describeError(error)).toBe('Error: no stack');
  });

  it('uses the error name when the message is empty', () => {
    const error = new TypeError();
    error.stack = 'TypeError';
    expect(describeError(error)).toBe('TypeError');
  });
});

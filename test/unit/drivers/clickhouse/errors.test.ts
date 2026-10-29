import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { syntaxPosition, toClickhouseDbError } from '../../../../src/drivers/clickhouse/errors';

function serverError(code: string, type: string, message = 'failed') {
  return Object.assign(new Error(message), { code, type });
}

describe('toClickhouseDbError', () => {
  it.each([
    ['UNKNOWN_TABLE', 'not-found'],
    ['UNKNOWN_DATABASE', 'not-found'],
    ['NO_SUCH_COLUMN_IN_TABLE', 'not-found'],
    ['CANNOT_GET_CREATE_TABLE_QUERY', 'not-found'],
    ['SYNTAX_ERROR', 'syntax'],
    ['AUTHENTICATION_FAILED', 'auth-failed'],
    ['READONLY', 'permission-denied'],
    ['ACCESS_DENIED', 'permission-denied'],
    ['QUERY_WAS_CANCELLED', 'cancelled'],
    ['TIMEOUT_EXCEEDED', 'timeout'],
    ['SESSION_IS_LOCKED', 'busy'],
    ['TYPE_MISMATCH', 'constraint'],
    ['FUNCTION_THROW_IF_VALUE_IS_NON_ZERO', 'constraint'],
    ['CANNOT_PARSE_TEXT', 'constraint'],
    ['CANNOT_READ_ALL_DATA', 'constraint'],
    ['TABLE_ALREADY_EXISTS', 'internal'],
  ] as const)('maps %s to %s', (type, code) => {
    const error = toClickhouseDbError(serverError('1', type));
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe(code);
    expect(error.driverCode).toBe(type);
  });

  it('finds a parse error in the message when the error has no name', () => {
    expect(toClickhouseDbError(new Error('Code: 6. CANNOT_PARSE_TEXT here')).code).toBe(
      'constraint',
    );
  });

  it('maps an aborted request to cancelled', () => {
    expect(toClickhouseDbError(new Error('The user aborted a request.')).code).toBe('cancelled');
    expect(toClickhouseDbError(Object.assign(new Error('x'), { name: 'AbortError' })).code).toBe(
      'cancelled',
    );
  });

  it('maps network codes and timeouts', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ECONNABORTED']) {
      expect(toClickhouseDbError(Object.assign(new Error('x'), { code })).code).toBe(
        'connection-failed',
      );
    }
    expect(toClickhouseDbError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code).toBe(
      'timeout',
    );
    expect(toClickhouseDbError(new Error('Timeout error.')).code).toBe('timeout');
  });

  it('falls back to internal, also for things that are not errors', () => {
    expect(toClickhouseDbError(new Error('strange')).code).toBe('internal');
    expect(toClickhouseDbError('text').code).toBe('internal');
    expect(toClickhouseDbError(null).code).toBe('internal');
    expect(toClickhouseDbError(serverError('1', 'toString')).code).toBe('internal');
  });

  it('passes a DbError through as it is', () => {
    const original = new DbError('busy', 'b');
    expect(toClickhouseDbError(original)).toBe(original);
  });

  it('keeps the cause and turns a syntax error position into an offset', () => {
    const cause = serverError('62', 'SYNTAX_ERROR', "Syntax error: failed at position 8 ('x')");
    const error = toClickhouseDbError(cause, 'SELECT 1 x');
    expect(error.position).toBe(7);
    expect(error.cause).toBe(cause);
    expect(toClickhouseDbError(cause).position).toBeUndefined();
  });
});

describe('syntaxPosition', () => {
  it('reads a 1-based byte offset', () => {
    expect(syntaxPosition('failed at position 1', 'SELEC')).toBe(0);
    expect(syntaxPosition('failed at position 16 (2)', 'SELECT 1\nSELEC 2')).toBe(15);
  });

  it('counts bytes, not characters, in text before the error', () => {
    // 'é' is 2 bytes, '日' 3, '🚀' 4 bytes and 2 UTF-16 units.
    expect(syntaxPosition('failed at position 6', "'é' x")).toBe(4);
    expect(syntaxPosition('failed at position 7', "'日' x")).toBe(4);
    expect(syntaxPosition('failed at position 8', "'🚀' x")).toBe(5);
  });

  it('points at the end when the offset is the end of the text', () => {
    expect(syntaxPosition('failed at position 9', 'SELECT 1')).toBe(8);
  });

  it('is undefined past the end or without a position', () => {
    expect(syntaxPosition('failed at position 50', 'SELECT 1')).toBeUndefined();
    expect(syntaxPosition('Syntax error', 'SELECT 1')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { toMysqlDbError } from '../../../../src/drivers/mysql/errors';

function mysqlError(fields: {
  errno?: number;
  code?: string;
  sqlState?: string;
  sqlMessage?: string;
  message?: string;
}): Error {
  const error = new Error(fields.message ?? fields.sqlMessage ?? 'mysql error');
  Object.assign(error, fields);
  return error;
}

describe('toMysqlDbError', () => {
  it('maps access denied to auth-failed with sqlState and errno', () => {
    const error = toMysqlDbError(
      mysqlError({
        errno: 1045,
        code: 'ER_ACCESS_DENIED_ERROR',
        sqlState: '28000',
        sqlMessage: "Access denied for user 'x'@'%'",
      }),
    );
    expect(error.code).toBe('auth-failed');
    expect(error.sqlState).toBe('28000');
    expect(error.driverCode).toBe(1045);
    expect(error.message).toContain('Access denied');
  });

  it('maps common server errors to categories', () => {
    expect(toMysqlDbError(mysqlError({ errno: 1064 })).code).toBe('syntax');
    expect(toMysqlDbError(mysqlError({ errno: 1062 })).code).toBe('constraint');
    expect(toMysqlDbError(mysqlError({ errno: 1146 })).code).toBe('not-found');
    expect(toMysqlDbError(mysqlError({ errno: 1317 })).code).toBe('cancelled');
    expect(toMysqlDbError(mysqlError({ errno: 1205 })).code).toBe('timeout');
    expect(toMysqlDbError(mysqlError({ errno: 1142 })).code).toBe('permission-denied');
  });

  it('maps a missing routine, trigger or event to not-found and a MariaDB unknown type to syntax', () => {
    for (const errno of [1305, 1360, 1539]) {
      expect(toMysqlDbError(mysqlError({ errno })).code).toBe('not-found');
    }
    expect(toMysqlDbError(mysqlError({ errno: 4161 })).code).toBe('syntax');
  });

  it('maps network failures to connection-failed', () => {
    expect(toMysqlDbError(mysqlError({ code: 'ECONNREFUSED' })).code).toBe('connection-failed');
    expect(toMysqlDbError(mysqlError({ code: 'PROTOCOL_CONNECTION_LOST' })).code).toBe(
      'connection-failed',
    );
  });

  it('falls back to internal for unknown errors and non-errors', () => {
    expect(toMysqlDbError(mysqlError({ errno: 99999 })).code).toBe('internal');
    expect(toMysqlDbError('string failure').code).toBe('internal');
    expect(toMysqlDbError(undefined).code).toBe('internal');
  });

  it('keeps an existing DbError untouched', () => {
    const original = new DbError('cancelled', 'stop');
    expect(toMysqlDbError(original)).toBe(original);
  });

  it('keeps the original error as cause', () => {
    const raw = mysqlError({ errno: 1064 });
    expect(toMysqlDbError(raw).cause).toBe(raw);
  });
});

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { toPgDbError } from '../../../../src/drivers/postgres/errors';

function pgError(fields: {
  code?: string;
  position?: string;
  detail?: string;
  message?: string;
}): Error {
  const error = new Error(fields.message ?? 'pg error');
  Object.assign(error, fields);
  return error;
}

describe('toPgDbError', () => {
  it('maps auth and syntax errors with a 0-based position', () => {
    expect(toPgDbError(pgError({ code: '28P01' })).code).toBe('auth-failed');
    const syntax = toPgDbError(pgError({ code: '42601', position: '15' }));
    expect(syntax.code).toBe('syntax');
    expect(syntax.position).toBe(14);
    expect(syntax.sqlState).toBe('42601');
  });

  it('maps catalog misses, constraints and cancellation', () => {
    expect(toPgDbError(pgError({ code: '42P01' })).code).toBe('not-found');
    expect(toPgDbError(pgError({ code: '3D000' })).code).toBe('not-found');
    expect(toPgDbError(pgError({ code: '23505', detail: 'Key (id)=(1)' })).detail).toBe(
      'Key (id)=(1)',
    );
    expect(toPgDbError(pgError({ code: '23505' })).code).toBe('constraint');
    expect(toPgDbError(pgError({ code: '57014' })).code).toBe('cancelled');
    expect(toPgDbError(pgError({ code: '42501' })).code).toBe('permission-denied');
  });

  it('maps whole SQLSTATE classes when no exact entry exists', () => {
    expect(toPgDbError(pgError({ code: '23001' })).code).toBe('constraint');
    expect(toPgDbError(pgError({ code: '08006' })).code).toBe('connection-failed');
    expect(toPgDbError(pgError({ code: '22012' })).code).toBe('constraint');
  });

  it('maps network errors and the pg connection timeout message', () => {
    expect(toPgDbError(pgError({ code: 'ECONNREFUSED' })).code).toBe('connection-failed');
    expect(toPgDbError(new Error('Connection terminated due to connection timeout')).code).toBe(
      'connection-failed',
    );
  });

  it('ignores a malformed position and falls back to internal', () => {
    const error = toPgDbError(pgError({ code: '42601', position: 'abc' }));
    expect(error.position).toBeUndefined();
    expect(toPgDbError('text').code).toBe('internal');
    expect(toPgDbError(undefined).code).toBe('internal');
  });

  it('keeps an existing DbError untouched', () => {
    const original = new DbError('cancelled', 'stop');
    expect(toPgDbError(original)).toBe(original);
  });
});

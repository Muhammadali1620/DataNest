import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { fromWireError, toSqliteDbError, toWireError } from '../../../../src/drivers/sqlite/errors';

function sqliteError(message: string, errcode?: number): Error {
  const error = new Error(message);
  Object.assign(error, { code: 'ERR_SQLITE_ERROR', errcode });
  return error;
}

describe('toSqliteDbError', () => {
  it('splits the generic SQLITE_ERROR by message', () => {
    expect(toSqliteDbError(sqliteError('no such table: users', 1)).code).toBe('not-found');
    expect(toSqliteDbError(sqliteError('no such column: x', 1)).code).toBe('not-found');
    expect(toSqliteDbError(sqliteError('near "SELEC": syntax error', 1)).code).toBe('syntax');
    expect(toSqliteDbError(sqliteError('table users already exists', 1)).code).toBe('constraint');
    expect(toSqliteDbError(sqliteError('something odd', 1)).code).toBe('internal');
  });

  it('maps extended constraint and io codes by their primary part', () => {
    expect(toSqliteDbError(sqliteError('UNIQUE constraint failed: t.id', 1555)).code).toBe(
      'constraint',
    );
    expect(toSqliteDbError(sqliteError('database is locked', 5)).code).toBe('timeout');
    expect(toSqliteDbError(sqliteError('unable to open database file', 14)).code).toBe(
      'connection-failed',
    );
    expect(toSqliteDbError(sqliteError('attempt to write a readonly database', 8)).code).toBe(
      'permission-denied',
    );
    expect(toSqliteDbError(sqliteError('file is not a database', 26)).code).toBe(
      'connection-failed',
    );
  });

  it('keeps the errcode as driverCode and the original as cause', () => {
    const raw = sqliteError('UNIQUE constraint failed', 1555);
    const error = toSqliteDbError(raw);
    expect(error.driverCode).toBe(1555);
    expect(error.cause).toBe(raw);
  });

  it('classifies ERR_SQLITE errors without errcode by message', () => {
    const raw = new Error('no such table: x');
    Object.assign(raw, { code: 'ERR_SQLITE_ERROR' });
    expect(toSqliteDbError(raw).code).toBe('not-found');
  });

  it('falls back to internal for unknown input and keeps DbError untouched', () => {
    expect(toSqliteDbError('text').code).toBe('internal');
    const original = new DbError('cancelled', 'stop');
    expect(toSqliteDbError(original)).toBe(original);
  });
});

describe('wire errors', () => {
  it('round-trips a DbError code across the worker boundary', () => {
    const wire = toWireError(sqliteError('near "x": syntax error', 1));
    expect(wire).toEqual({ code: 'syntax', message: 'near "x": syntax error' });
    const back = fromWireError(wire);
    expect(back).toBeInstanceOf(DbError);
    expect(back.code).toBe('syntax');
  });

  it('refuses to resurrect an unknown code', () => {
    expect(fromWireError({ code: 'weird', message: 'm' }).code).toBe('internal');
  });
});

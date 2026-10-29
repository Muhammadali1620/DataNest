import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { lineStart, positionOf, toMssqlDbError } from '../../../../src/drivers/mssql/errors';

function serverError(number: number, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code: 'EREQUEST', number, ...extra });
}

describe('toMssqlDbError', () => {
  it.each([
    [208, 'not-found'],
    [207, 'not-found'],
    [2812, 'not-found'],
    [4060, 'not-found'],
    [102, 'syntax'],
    [156, 'syntax'],
    [229, 'permission-denied'],
    [18456, 'auth-failed'],
    [2627, 'constraint'],
    [547, 'constraint'],
    [515, 'constraint'],
    [8134, 'constraint'],
    [1205, 'constraint'],
    [1222, 'timeout'],
  ] as const)('maps server error %i to %s', (number, code) => {
    const error = toMssqlDbError(serverError(number, 'm'));
    expect(error).toMatchObject({ code, driverCode: number, message: 'm' });
  });

  it('treats THROW and RAISERROR numbers of the user as constraint violations', () => {
    expect(toMssqlDbError(serverError(50_001, 'x')).code).toBe('constraint');
    expect(toMssqlDbError(serverError(50_000, 'x')).code).toBe('constraint');
    expect(toMssqlDbError(serverError(9999, 'x')).code).toBe('internal');
  });

  it('maps tedious own codes for errors that never reached the server', () => {
    const coded = (code: string, message = 'x') => Object.assign(new Error(message), { code });
    expect(toMssqlDbError(coded('ESOCKET')).code).toBe('connection-failed');
    expect(toMssqlDbError(coded('ETIMEOUT')).code).toBe('timeout');
    expect(toMssqlDbError(coded('ECANCEL')).code).toBe('cancelled');
    expect(toMssqlDbError(coded('ELOGIN')).code).toBe('auth-failed');
    expect(toMssqlDbError(coded('ELOGIN', 'Cannot open database "x"')).code).toBe('not-found');
    expect(toMssqlDbError(coded('ECONNREFUSED')).code).toBe('connection-failed');
    expect(toMssqlDbError(coded('EWHATEVER')).code).toBe('internal');
    expect(toMssqlDbError(coded('ESOCKET')).driverCode).toBe('ESOCKET');
  });

  it('sees a network failure inside an aggregate error', () => {
    const error = Object.assign(new Error('Failed to connect'), {
      code: 'ESOCKET',
      errors: [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
    });
    expect(toMssqlDbError(error).code).toBe('connection-failed');
  });

  it('takes the first server error of several that arrive together', () => {
    const error = Object.assign(new AggregateError([], 'several'), {
      errors: [
        serverError(547, 'The INSERT statement conflicted with the FOREIGN KEY constraint'),
        serverError(3621, 'The statement has been terminated.'),
      ],
    });
    const mapped = toMssqlDbError(error);
    expect(mapped).toMatchObject({ code: 'constraint', driverCode: 547 });
    expect(mapped.message).toMatch(/FOREIGN KEY/u);
  });

  it('turns the line of the batch into a position at the quoted name', () => {
    const sql = 'SELECT 1\n  SELECT * FROM missing';
    const error = toMssqlDbError(
      serverError(208, "Invalid object name 'missing'.", { lineNumber: 2 }),
      sql,
    );
    expect(error.position).toBe(sql.indexOf('missing'));
    expect(error.detail).toBeUndefined();
  });

  it('says where inside a procedure instead of guessing a position', () => {
    const error = toMssqlDbError(
      serverError(50_001, 'quantity must be positive', {
        lineNumber: 7,
        procName: 'order_items_quantity_check',
      }),
      'INSERT INTO order_items VALUES (1)',
    );
    expect(error.position).toBeUndefined();
    expect(error.detail).toBe('In order_items_quantity_check, line 7');
  });

  it('gives no position without the batch or the line', () => {
    expect(toMssqlDbError(serverError(102, 'x', { lineNumber: 1 })).position).toBeUndefined();
    expect(
      toMssqlDbError(serverError(102, 'x', { lineNumber: 0 }), 'SELECT').position,
    ).toBeUndefined();
    expect(
      toMssqlDbError(serverError(102, 'x', { lineNumber: 5 }), 'SELECT').position,
    ).toBeUndefined();
  });

  it('passes a DbError through and copes with anything thrown', () => {
    const original = new DbError('busy', 'b');
    expect(toMssqlDbError(original)).toBe(original);
    expect(toMssqlDbError('boom')).toMatchObject({ code: 'internal', message: 'boom' });
    expect(toMssqlDbError(null)).toMatchObject({ code: 'internal' });
    expect(toMssqlDbError(serverError(208, 'x')).cause).toBeInstanceOf(Error);
  });
});

describe('positionOf', () => {
  const sql = 'SELECT 1\nSELECT [Order Id], x FROM dbo.Orders\nWHERE y = 1';

  it('points at a quoted name on the line, without case and schema', () => {
    expect(positionOf(sql, 2, "Invalid object name 'DBO.ORDERS'.")).toBe(sql.indexOf('Orders'));
    expect(positionOf(sql, 2, "Invalid column name 'Order Id'.")).toBe(sql.indexOf('[Order Id]'));
    expect(positionOf(sql, 2, "Incorrect syntax near the keyword 'FROM'.")).toBe(
      sql.indexOf('FROM'),
    );
    expect(positionOf(sql, 3, "Incorrect syntax near 'y'.")).toBe(sql.indexOf('y ='));
  });

  it('falls back to the start of the line', () => {
    expect(positionOf(sql, 2, "Invalid column name 'nope'.")).toBe(sql.indexOf('SELECT ['));
    expect(positionOf(sql, 2, 'Something else')).toBe(sql.indexOf('SELECT ['));
    expect(positionOf(sql, 3, "Incorrect syntax near ''.")).toBe(sql.indexOf('WHERE'));
    expect(positionOf(sql, 9, "Invalid object name 'x'.")).toBeUndefined();
  });
});

describe('lineStart', () => {
  it('finds the first non-blank character of a line', () => {
    expect(lineStart('a\n  \tb', 2)).toBe(5);
    expect(lineStart('a', 1)).toBe(0);
    expect(lineStart('a\n', 2)).toBe(2);
    expect(lineStart('a', 2)).toBeUndefined();
  });
});

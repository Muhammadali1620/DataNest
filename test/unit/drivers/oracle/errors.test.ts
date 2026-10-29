import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { toOracleDbError } from '../../../../src/drivers/oracle/errors';

function oraError(errorNum: number, message = `ORA-${String(errorNum).padStart(5, '0')}: failed`) {
  return Object.assign(new Error(message), {
    errorNum,
    code: `ORA-${String(errorNum).padStart(5, '0')}`,
  });
}

describe('toOracleDbError', () => {
  it.each([
    [942, 'not-found'],
    [904, 'not-found'],
    [4043, 'not-found'],
    [31603, 'not-found'],
    [2289, 'not-found'],
    [1918, 'not-found'],
    [12514, 'not-found'],
    [900, 'syntax'],
    [905, 'syntax'],
    [906, 'syntax'],
    [907, 'syntax'],
    [911, 'syntax'],
    [923, 'syntax'],
    [933, 'syntax'],
    [936, 'syntax'],
    [1756, 'syntax'],
    [6550, 'syntax'],
    [1017, 'auth-failed'],
    [28000, 'auth-failed'],
    [28001, 'auth-failed'],
    [1031, 'permission-denied'],
    [1013, 'cancelled'],
    [1, 'constraint'],
    [1400, 'constraint'],
    [1407, 'constraint'],
    [2290, 'constraint'],
    [2291, 'constraint'],
    [2292, 'constraint'],
    [1438, 'constraint'],
    [12899, 'constraint'],
    [1722, 'constraint'],
    [1840, 'constraint'],
    [1841, 'constraint'],
    [1843, 'constraint'],
    [1847, 'constraint'],
    [1861, 'constraint'],
    [1476, 'constraint'],
    [60, 'constraint'],
    [54, 'busy'],
    [3113, 'connection-failed'],
    [3114, 'connection-failed'],
    [3135, 'connection-failed'],
    [12541, 'connection-failed'],
    [12170, 'timeout'],
  ] as const)('maps ORA-%i to %s', (errorNum, code) => {
    const error = toOracleDbError(oraError(errorNum));
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe(code);
    expect(error.driverCode).toBe(`ORA-${String(errorNum).padStart(5, '0')}`);
  });

  it('reads the number from the code when errorNum is missing or zero', () => {
    expect(toOracleDbError({ code: 'ORA-00942', message: 'no table' })).toMatchObject({
      code: 'not-found',
      driverCode: 'ORA-00942',
    });
    expect(toOracleDbError({ code: 'ORA-01017', errorNum: 0 }).code).toBe('auth-failed');
    expect(toOracleDbError({ code: 'ORA-1013', errorNum: -1 })).toMatchObject({
      code: 'cancelled',
      driverCode: 'ORA-01013',
    });
  });

  it('prefers errorNum over the code', () => {
    expect(toOracleDbError({ errorNum: 1, code: 'ORA-00942' })).toMatchObject({
      code: 'constraint',
      driverCode: 'ORA-00001',
    });
  });

  it('pads the driver code to five digits and keeps longer numbers whole', () => {
    expect(toOracleDbError({ errorNum: 1 }).driverCode).toBe('ORA-00001');
    expect(toOracleDbError({ errorNum: 942 }).driverCode).toBe('ORA-00942');
    expect(toOracleDbError({ errorNum: 123456 }).driverCode).toBe('ORA-123456');
  });

  it('treats the application errors of RAISE_APPLICATION_ERROR as constraints', () => {
    expect(toOracleDbError(oraError(20000)).code).toBe('constraint');
    expect(toOracleDbError(oraError(20500)).code).toBe('constraint');
    expect(toOracleDbError(oraError(20999)).code).toBe('constraint');
    expect(toOracleDbError({ code: 'ORA-20001' }).code).toBe('constraint');
    expect(toOracleDbError(oraError(19999)).code).toBe('internal');
    expect(toOracleDbError(oraError(21000)).code).toBe('internal');
  });

  it('keeps an unknown ORA number internal, with its code', () => {
    const error = toOracleDbError(oraError(955, 'ORA-00955: name is already used'));
    expect(error).toMatchObject({
      code: 'internal',
      driverCode: 'ORA-00955',
      message: 'ORA-00955: name is already used',
    });
  });

  it('maps NJS-518, an unknown service, to not-found', () => {
    expect(toOracleDbError({ code: 'NJS-518', message: 'no service' })).toMatchObject({
      code: 'not-found',
      driverCode: 'NJS-518',
    });
  });

  it.each(['NJS-500', 'NJS-501', 'NJS-503', 'NJS-511', 'NJS-003', 'NJS-040'])(
    'maps %s, a connection that failed or was lost, to connection-failed',
    (code) => {
      expect(toOracleDbError(Object.assign(new Error('x'), { code }))).toMatchObject({
        code: 'connection-failed',
        driverCode: code,
      });
    },
  );

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EADDRNOTAVAIL',
  ])('maps the network code %s to connection-failed', (code) => {
    expect(toOracleDbError(Object.assign(new Error('x'), { code }))).toMatchObject({
      code: 'connection-failed',
      driverCode: code,
    });
  });

  it('finds a network failure in the message when no code says it', () => {
    for (const word of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH']) {
      expect(toOracleDbError(new Error(`connect ${word} 127.0.0.1:1521`)).code).toBe(
        'connection-failed',
      );
    }
    expect(toOracleDbError(new Error('read ECONNRESET')).code).toBe('internal');
  });

  it('keeps other NJS codes internal', () => {
    expect(toOracleDbError({ code: 'NJS-098', message: 'bind' })).toMatchObject({
      code: 'internal',
      driverCode: 'NJS-098',
    });
  });

  it('gives the error offset as the position, when there is one', () => {
    expect(toOracleDbError({ errorNum: 942, offset: 14 }).position).toBe(14);
    expect(toOracleDbError({ errorNum: 942, offset: 0 }).position).toBeUndefined();
    expect(toOracleDbError({ errorNum: 942, offset: -3 }).position).toBeUndefined();
    expect(toOracleDbError({ errorNum: 942, offset: '14' }).position).toBeUndefined();
    expect(toOracleDbError({ errorNum: 942 }).position).toBeUndefined();
  });

  it('keeps the original error as the cause and its message', () => {
    const original = oraError(942, 'ORA-00942: table or view does not exist');
    const error = toOracleDbError(original);
    expect(error.cause).toBe(original);
    expect(error.message).toBe('ORA-00942: table or view does not exist');
  });

  it('passes a DbError through unchanged', () => {
    const error = new DbError('unsupported', 'nope');
    expect(toOracleDbError(error)).toBe(error);
  });

  it('wraps anything that is not an object as an internal error', () => {
    for (const value of ['boom', 42, null, undefined]) {
      const error = toOracleDbError(value);
      expect(error).toBeInstanceOf(DbError);
      expect(error.code).toBe('internal');
      expect(error.driverCode).toBeUndefined();
      expect(error.position).toBeUndefined();
    }
    expect(toOracleDbError('boom').message).toMatch(/boom/u);
  });

  it('ignores codes and numbers that are not of the right type', () => {
    expect(toOracleDbError({ code: 942, errorNum: '942' })).toMatchObject({
      code: 'internal',
      driverCode: undefined,
    });
    expect(toOracleDbError({ code: 'ORA-XYZ' })).toMatchObject({
      code: 'internal',
      driverCode: 'ORA-XYZ',
    });
  });
});

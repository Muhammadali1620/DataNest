import { describe, expect, it } from 'vitest';
import { failureText, rabbitFailure, statusKind } from '../../../../src/drivers/rabbitmq/errors';

describe('RabbitMQ errors (V13.26)', () => {
  it.each([
    [401, 'auth-failed'],
    [403, 'permission-denied'],
    [404, 'not-found'],
    [408, 'timeout'],
    [504, 'timeout'],
    [409, 'constraint'],
    [412, 'constraint'],
    [429, 'busy'],
    [503, 'busy'],
    [400, 'syntax'],
    [422, 'syntax'],
    [500, 'internal'],
    [502, 'internal'],
  ] as const)('maps HTTP %i to %s', (status, code) => {
    expect(statusKind(status)).toBe(code);
  });

  it('puts the error and the reason of the broker together', () => {
    expect(failureText(404, '{"error":"Object Not Found","reason":"Not Found"}')).toBe(
      'Object Not Found: Not Found',
    );
    expect(failureText(400, '{"reason":"PRECONDITION_FAILED - inequivalent arg"}')).toBe(
      'PRECONDITION_FAILED - inequivalent arg',
    );
  });

  it('falls back to the error word, the body and the status', () => {
    expect(failureText(401, '{"error":"not_authorised"}')).toBe('not_authorised');
    expect(failureText(502, '<html>Bad gateway</html>')).toBe('HTTP 502: <html>Bad gateway</html>');
    expect(failureText(500, '')).toBe('HTTP 500');
    expect(failureText(500, '  ')).toBe('HTTP 500');
    expect(failureText(500, 'x'.repeat(500))).toBe(`HTTP 500: ${'x'.repeat(300)}`);
    expect(failureText(500, '{"error":"","reason":""}')).toBe('HTTP 500: {"error":"","reason":""}');
  });

  it('makes a DbError that carries the status', () => {
    const error = rabbitFailure(404, '{"error":"Object Not Found","reason":"Not Found"}');
    expect(error.code).toBe('not-found');
    expect(error.driverCode).toBe(404);
    expect(error.message).toBe('Object Not Found: Not Found');
  });
});

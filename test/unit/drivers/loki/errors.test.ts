import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { fromHttpStatus, toLokiError } from '../../../../src/drivers/loki/errors';

describe('fromHttpStatus', () => {
  it('names a refusal to sign in and a refusal of rights', () => {
    expect(fromHttpStatus(401, 'no org id')).toMatchObject({
      code: 'auth-failed',
      message: 'no org id',
      driverCode: 401,
    });
    expect(fromHttpStatus(403, '')).toMatchObject({ code: 'permission-denied' });
    expect(fromHttpStatus(401, '').message).toMatch(/refused/u);
  });

  it('calls a parse error a syntax error and shows the words of Loki', () => {
    const error = fromHttpStatus(
      400,
      'parse error at line 1, col 6: syntax error: unexpected $end, expecting STRING',
    );
    expect(error.code).toBe('syntax');
    expect(error.message).toContain('unexpected $end');
  });

  it('calls a limit that was exceeded unsupported, so the message is shown as it is', () => {
    expect(
      fromHttpStatus(400, 'max entries limit per query exceeded, limit > max_entries_limit'),
    ).toMatchObject({ code: 'unsupported' });
    expect(fromHttpStatus(429, 'Too many outstanding requests')).toMatchObject({
      code: 'unsupported',
      driverCode: 429,
    });
  });

  it('tells a timeout and a missing path', () => {
    expect(fromHttpStatus(504, '')).toMatchObject({ code: 'timeout' });
    expect(fromHttpStatus(500, 'context deadline exceeded')).toMatchObject({ code: 'timeout' });
    expect(fromHttpStatus(404, '404 page not found')).toMatchObject({ code: 'not-found' });
  });

  it('calls an unready or unreachable server a lost connection', () => {
    expect(fromHttpStatus(503, 'Ingester not ready')).toMatchObject({ code: 'connection-failed' });
    expect(fromHttpStatus(502, '')).toMatchObject({ code: 'connection-failed' });
  });

  it('calls other server failures internal', () => {
    expect(fromHttpStatus(500, 'boom')).toMatchObject({ code: 'internal', driverCode: 500 });
  });

  it('calls any other client error a syntax error, whatever its words', () => {
    expect(fromHttpStatus(400, 'something odd')).toMatchObject({ code: 'syntax' });
    expect(fromHttpStatus(422, '')).toMatchObject({ code: 'syntax' });
  });

  it('reads the message of a JSON body, as a gateway may send it', () => {
    expect(fromHttpStatus(400, JSON.stringify({ message: 'bad input' })).message).toBe('bad input');
    expect(fromHttpStatus(400, JSON.stringify({ error: 'bad too' })).message).toBe('bad too');
    expect(fromHttpStatus(400, JSON.stringify({ other: 1 })).message).toContain('"other"');
  });

  it('shows a body that is not JSON as it is, cut to a sensible length', () => {
    const long = 'x'.repeat(2000);
    expect(fromHttpStatus(500, long).message).toHaveLength(800);
    expect(fromHttpStatus(500, '').message).toMatch(/HTTP status 500/u);
  });
});

describe('toLokiError', () => {
  it('keeps an error that is already ours', () => {
    const own = new DbError('syntax', 'x');
    expect(toLokiError(own)).toBe(own);
  });

  it('calls a network failure a lost connection', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(toLokiError(refused)).toMatchObject({
      code: 'connection-failed',
      driverCode: 'ECONNREFUSED',
    });
    const odd = Object.assign(new Error('bad'), { code: 'ERR_INVALID_URL' });
    expect(toLokiError(odd).code).toBe('connection-failed');
  });

  it('calls anything else internal', () => {
    expect(toLokiError(new Error('odd'))).toMatchObject({ code: 'internal', message: 'odd' });
    expect(toLokiError('text').code).toBe('internal');
  });
});

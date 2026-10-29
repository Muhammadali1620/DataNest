import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  elasticFailure,
  failureText,
  networkFailure,
  statusKind,
} from '../../../../src/drivers/elasticsearch/errors';
import { json } from '../../../helpers/fake-elastic';

describe('Elasticsearch errors (V7.8)', () => {
  it.each([
    [400, 'syntax'],
    [401, 'auth-failed'],
    [403, 'permission-denied'],
    [404, 'not-found'],
    [405, 'syntax'],
    [408, 'timeout'],
    [409, 'constraint'],
    [413, 'syntax'],
    [429, 'busy'],
    [500, 'internal'],
    [503, 'busy'],
    [504, 'timeout'],
  ])('reads status %i as %s', (status, kind) => {
    expect(statusKind(status)).toBe(kind);
  });

  it('names the root cause the body gives', () => {
    expect(
      failureText(
        json(
          {
            error: {
              root_cause: [{ type: 'index_not_found_exception', reason: 'no such index [x]' }],
              type: 'outer',
              reason: 'outer reason',
            },
          },
          404,
        ),
      ),
    ).toBe('index_not_found_exception: no such index [x]');
    expect(failureText(json({ error: { type: 'parsing_exception', reason: 'bad' } }, 400))).toBe(
      'parsing_exception: bad',
    );
    expect(failureText(json({ error: 'Incorrect HTTP method' }, 405))).toBe(
      'Incorrect HTTP method',
    );
    expect(failureText(json({ error: { root_cause: [] } }, 500))).toBe(
      'HTTP 500: {"error":{"root_cause":[]}}',
    );
  });

  it('falls back to the status for a body that is not JSON', () => {
    expect(failureText({ status: 502, body: '', contentType: '' })).toBe('HTTP 502');
    expect(
      failureText({ status: 502, body: '<html>Bad Gateway</html>', contentType: 'text/html' }),
    ).toBe('HTTP 502: <html>Bad Gateway</html>');
  });

  it('keeps the status as the driver code', () => {
    expect(elasticFailure(json({ error: 'x' }, 403))).toMatchObject({
      code: 'permission-denied',
      driverCode: 403,
    });
  });

  it('calls network failures lost links, and says TLS met a plain port', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(networkFailure(refused)).toMatchObject({
      code: 'connection-failed',
      driverCode: 'ECONNREFUSED',
    });
    expect(networkFailure(new Error('socket hang up')).code).toBe('connection-failed');
    expect(
      networkFailure(
        Object.assign(new Error('wrong version'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }),
      ).message,
    ).toContain('TLS failed');
    const own = new DbError('timeout', 'slow');
    expect(networkFailure(own)).toBe(own);
    expect(networkFailure(new Error('odd')).code).toBe('internal');
  });
});

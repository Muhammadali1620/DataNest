import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { isReplyError, replyCode, toRedisDbError } from '../../../../src/drivers/redis/errors';

/** What ioredis throws for an error reply. */
function reply(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

describe('replyCode', () => {
  it('is the leading uppercase word of an error reply', () => {
    expect(replyCode('WRONGTYPE Operation against a key')).toBe('WRONGTYPE');
    expect(replyCode('ERR unknown command')).toBe('ERR');
    expect(replyCode('connect ECONNREFUSED')).toBeUndefined();
  });
});

describe('isReplyError', () => {
  it('knows ioredis reply errors only', () => {
    expect(isReplyError(reply('ERR x'))).toBe(true);
    expect(isReplyError(new Error('ERR x'))).toBe(false);
    expect(isReplyError('ERR x')).toBe(false);
  });
});

describe('toRedisDbError', () => {
  it.each([
    ['WRONGPASS invalid username-password pair', 'auth-failed'],
    ['NOAUTH Authentication required.', 'auth-failed'],
    ['NOPERM User reader has no permissions to run the set command', 'permission-denied'],
    ["READONLY You can't write against a read only replica.", 'permission-denied'],
    ['WRONGTYPE Operation against a key holding the wrong kind of value', 'constraint'],
    ['EXECABORT Transaction discarded', 'constraint'],
    ['OOM command not allowed when used memory > maxmemory', 'constraint'],
    ['NOGROUP No such key or consumer group', 'not-found'],
    ['BUSY Redis is busy running a script', 'busy'],
    ['LOADING Redis is loading the dataset in memory', 'busy'],
    ['CLUSTERDOWN The cluster is down', 'busy'],
    ["ERR unknown command 'NOPE', with args beginning with:", 'syntax'],
    ["ERR wrong number of arguments for 'get' command", 'syntax'],
    ['ERR syntax error', 'syntax'],
    ['ERR value is not an integer or out of range', 'constraint'],
    ['ERR value is not a valid float', 'constraint'],
    ['ERR no such key', 'not-found'],
    ['ERR DB index is out of range', 'not-found'],
    ['ERR AUTH <password> called without any password configured', 'auth-failed'],
    ['ERR something else entirely', 'internal'],
    ['WEIRD new code', 'internal'],
  ] as const)('maps "%s" to %s', (message, code) => {
    const mapped = toRedisDbError(reply(message));
    expect(mapped).toBeInstanceOf(DbError);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe(message);
    expect(mapped.driverCode).toBe(replyCode(message));
  });

  it('turns network errors into a lost connection', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    expect(toRedisDbError(error)).toMatchObject({
      code: 'connection-failed',
      driverCode: 'ECONNREFUSED',
    });
  });

  it("knows ioredis's own texts for a link that is gone", () => {
    for (const message of [
      'Connection is closed.',
      'All sentinels are unreachable and retry is disabled.',
      'Failed to refresh slots cache.',
      'None of startup nodes is available',
    ]) {
      expect(toRedisDbError(new Error(message)).code, message).toBe('connection-failed');
    }
  });

  it('keeps a DbError and makes anything else internal', () => {
    const own = new DbError('timeout', 'slow');
    expect(toRedisDbError(own)).toBe(own);
    expect(toRedisDbError(new Error('odd')).code).toBe('internal');
    expect(toRedisDbError('odd').code).toBe('internal');
  });
});

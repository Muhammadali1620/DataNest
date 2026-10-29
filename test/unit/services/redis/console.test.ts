import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RedisReply } from '../../../../src/drivers/redis-driver';
import { type ConsoleQuestion, RedisConsole } from '../../../../src/services/redis/console';
import type { SafeMode } from '../../../../src/services/safe-mode';
import type { WritePolicy } from '../../../../src/services/write-policy';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

/** COMMAND INFO of a few commands as Redis 7 describes them. */
const FLAGS: Record<string, [string[], string[]]> = {
  get: [['readonly', 'fast'], ['@read']],
  set: [['write', 'denyoom'], ['@write']],
  flushall: [['write'], ['@keyspace', '@write', '@dangerous']],
  keys: [['readonly'], ['@keyspace', '@read', '@dangerous']],
  info: [
    ['loading', 'stale'],
    ['@slow', '@dangerous'],
  ],
  select: [
    ['loading', 'fast'],
    ['@fast', '@connection'],
  ],
};

function server(replies: (words: string[]) => RedisReply | Error | undefined = () => bulk('OK')) {
  return new FakeRedisSession((words) => {
    if (words[0] === 'COMMAND') {
      const name = words[2]?.toLowerCase() ?? '';
      const entry = FLAGS[name];
      return entry === undefined
        ? [null]
        : [[bulk(name), '-1', entry[0].map(bulk), '0', '0', '0', entry[1].map(bulk)]];
    }
    return replies(words);
  });
}

function setup(
  options: {
    policy?: Partial<WritePolicy>;
    safeMode?: SafeMode;
    answer?: boolean;
    session?: FakeRedisSession;
  } = {},
) {
  const session = options.session ?? server();
  const confirm = vi.fn((_question: ConsoleQuestion) => Promise.resolve(options.answer ?? true));
  const onDatabase = vi.fn();
  let clock = 1000;
  const console = new RedisConsole({
    session: () => Promise.resolve(session),
    policy: { name: 'Cache', production: false, readOnly: false, ...options.policy },
    safeMode: () => options.safeMode ?? 'off',
    confirm,
    onDatabase,
    maxItems: 2,
    now: () => (clock += 5),
  });
  return { console, session, confirm, onDatabase };
}

const ran = (session: FakeRedisSession) => session.calls.filter((call) => call[0] !== 'COMMAND');

describe('RedisConsole', () => {
  it('runs a line and prints the reply as redis-cli does, with the time', async () => {
    const { console, session } = setup({
      session: server(() => [bulk('a'), bulk('b'), bulk('c')]),
    });
    expect(await console.run('  lrange "my list" 0 -1 ')).toEqual({
      command: 'lrange "my list" 0 -1',
      lines: ['1) "a"', '2) "b"', '(1 more)'],
      error: false,
      ms: 5,
    });
    expect(session.calls).toEqual([['lrange', 'my list', '0', '-1']]);
  });

  it('skips blank lines and comments', async () => {
    const { console, session } = setup();
    expect(await console.run('   ')).toBeUndefined();
    expect(await console.run('# a note')).toBeUndefined();
    expect(session.calls).toEqual([]);
  });

  it('says what is wrong with a line that does not parse', async () => {
    const { console } = setup();
    expect(await console.run('SET k "open')).toEqual({
      command: 'SET k "open',
      lines: ['(refused) A quote is not closed'],
      error: true,
    });
    expect((await console.run('SET "a"b'))?.lines[0]).toContain('closing quote');
  });

  it('refuses commands a console line cannot show or that would change the connection', async () => {
    const { console, session } = setup();
    for (const line of ['SUBSCRIBE news', 'monitor', 'AUTH x', 'HELLO 3', 'QUIT', 'RESET']) {
      const result = await console.run(line);
      expect(result?.error, line).toBe(true);
      expect(result?.lines[0], line).toMatch(/^\(refused\)/);
    }
    expect(session.calls).toEqual([]);
  });

  it('prints error replies and a lost link', async () => {
    const failing = server((words) =>
      words[0] === 'INCR'
        ? new DbError('constraint', 'ERR not an integer')
        : new DbError('connection-failed', 'gone'),
    );
    const { console } = setup({ session: failing });
    expect((await console.run('INCR name'))?.lines).toEqual(['(error) ERR not an integer']);
    expect((await console.run('PING'))?.lines).toEqual([
      '(error) gone',
      '(the link is gone: the next command connects again)',
    ]);
  });

  it('follows SELECT to the new database', async () => {
    const { console, onDatabase } = setup();
    await console.run('SELECT 3');
    expect(onDatabase).toHaveBeenCalledWith(3);
    const failing = setup({
      session: server(() => new DbError('not-found', 'ERR DB index is out of range')),
    });
    await failing.console.run('SELECT 99');
    expect(failing.onDatabase).not.toHaveBeenCalled();
  });

  it('asks nothing and checks nothing on an ordinary connection with safe mode off', async () => {
    const { console, session, confirm } = setup();
    await console.run('FLUSHALL');
    expect(confirm).not.toHaveBeenCalled();
    expect(session.calls).toEqual([['FLUSHALL']]);
  });

  describe('read-only (V4.6)', () => {
    it('runs reads and refuses writes, asking the server once per command', async () => {
      const { console, session } = setup({ policy: { readOnly: true } });
      expect((await console.run('GET a'))?.error).toBe(false);
      expect((await console.run('GET b'))?.error).toBe(false);
      expect((await console.run('SET a 1'))?.lines[0]).toMatch(/read-only/);
      expect((await console.run('INFO'))?.error).toBe(false);
      expect(session.calls.filter((call) => call[0] === 'COMMAND')).toHaveLength(3);
      expect(ran(session)).toEqual([['GET', 'a'], ['GET', 'b'], ['INFO']]);
    });

    it('refuses a command the server does not describe', async () => {
      const { console } = setup({ policy: { readOnly: true } });
      expect((await console.run('MYMODULE.DO x'))?.lines[0]).toMatch(/does not say/);
    });
  });

  describe('production and safe mode', () => {
    it('asks before a write on production, and runs it only when agreed', async () => {
      const agreed = setup({ policy: { production: true } });
      await agreed.console.run('SET a 1');
      expect(agreed.confirm).toHaveBeenCalledWith({ kind: 'production', command: 'SET a 1' });
      expect(ran(agreed.session)).toEqual([['SET', 'a', '1']]);
      const declined = setup({ policy: { production: true }, answer: false });
      expect((await declined.console.run('SET a 1'))?.lines).toEqual(['(refused) Not run']);
      expect(ran(declined.session)).toEqual([]);
      await declined.console.run('GET a');
      expect(declined.confirm).toHaveBeenCalledTimes(1);
    });

    it('asks before dangerous writes and KEYS in confirm mode, once on production', async () => {
      const { console, confirm } = setup({ safeMode: 'confirm', policy: { production: true } });
      await console.run('FLUSHALL');
      await console.run('KEYS *');
      await console.run('INFO');
      expect(confirm.mock.calls.map(([question]) => question)).toEqual([
        { kind: 'dangerous', command: 'FLUSHALL', production: true },
        { kind: 'dangerous', command: 'KEYS *', production: true },
      ]);
    });

    it('refuses dangerous commands in block mode', async () => {
      const { console, session, confirm } = setup({ safeMode: 'block' });
      expect((await console.run('flushall'))?.lines[0]).toMatch(/Safe mode blocks/);
      expect(ran(session)).toEqual([]);
      expect(confirm).not.toHaveBeenCalled();
      expect((await console.run('SET a 1'))?.error).toBe(false);
    });
  });

  it('completes key names from SCAN, quoted-safe and sorted', async () => {
    const session = server();
    session.keyspace = [['user:2', 'user:1', 'app', 'user:*x']];
    const { console } = setup({ session });
    expect(await console.completeKeys('user:')).toEqual(['user:*x', 'user:1', 'user:2']);
    expect(session.scans[0]?.match).toBe('user:*');
    expect(await console.completeKeys('user:*')).toEqual(['user:*x']);
    expect(session.scans[1]?.match).toBe('user:\\**');
  });
});

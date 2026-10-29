import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RedisReply } from '../../../../src/drivers/redis-driver';
import { initCommands, setUpRedisSession } from '../../../../src/services/redis/redis-setup';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

const withInit = (initSql: string) => ({ options: { initSql } });

/** `COMMAND INFO` of a few commands, as Redis 7 describes them. */
function commandInfo(name: string): RedisReply {
  const flags: Record<string, [string[], string[]]> = {
    client: [['noscript'], ['@slow']],
    'client|setname': [
      ['noscript', 'loading', 'stale'],
      ['@slow', '@connection'],
    ],
    'client|kill': [
      ['admin', 'noscript'],
      ['@admin', '@dangerous', '@connection'],
    ],
    ping: [['fast'], ['@fast', '@connection']],
    set: [
      ['write', 'denyoom'],
      ['@write', '@string'],
    ],
  };
  const entry = (key: string): RedisReply => {
    const [f, c] = flags[key] ?? [[], []];
    const subs = key === 'client' ? [entry('client|setname'), entry('client|kill')] : [];
    return [bulk(key), '-1', f.map(bulk), '0', '0', '0', c.map(bulk), [], [], subs];
  };
  return name in flags ? [entry(name)] : [null];
}

function server(failing: Record<string, string> = {}): FakeRedisSession {
  return new FakeRedisSession((words) => {
    const [name = '', ...rest] = words;
    if (name === 'COMMAND') {
      return commandInfo(rest[1]?.toLowerCase() ?? '');
    }
    const failure = failing[name.toUpperCase()];
    return failure === undefined ? bulk('OK') : new DbError('syntax', failure);
  });
}

describe('initCommands', () => {
  it('reads one command per line, skipping blanks and comments', () => {
    const commands = initCommands(
      withInit('CLIENT SETNAME app\n\n  # a note\r\nCONFIG GET "max memory"'),
    );
    expect(commands.map((command) => command.line)).toEqual([
      'CLIENT SETNAME app',
      'CONFIG GET "max memory"',
    ]);
    expect(commands[1]?.words).toEqual(['CONFIG', 'GET', 'max memory']);
  });

  it('has nothing to run without init commands', () => {
    expect(initCommands({})).toEqual([]);
    expect(initCommands(withInit('   '))).toEqual([]);
  });

  it('refuses a line that does not parse', () => {
    expect(() => initCommands(withInit('SET k "open'))).toThrow(
      expect.objectContaining({
        code: 'syntax',
        message: expect.stringContaining('SET k "open') as unknown,
      }),
    );
  });

  it('refuses commands that would change what the connection is', () => {
    for (const line of ['select 3', 'AUTH x', 'MULTI', 'subscribe news', 'HELLO 3']) {
      expect(() => initCommands(withInit(line)), line).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
    }
  });
});

describe('setUpRedisSession', () => {
  it('runs the init commands in order', async () => {
    const session = server();
    await setUpRedisSession(session, withInit('CLIENT SETNAME app\nPING'));
    expect(session.calls).toEqual([['CLIENT', 'SETNAME', 'app'], ['PING']]);
  });

  it('names the command that failed', async () => {
    const session = server({ CLIENT: 'ERR not allowed' });
    await expect(setUpRedisSession(session, withInit('CLIENT SETNAME app'))).rejects.toMatchObject({
      code: 'syntax',
      message: 'Init command "CLIENT SETNAME app" failed: ERR not allowed',
    });
  });

  it('on a read-only connection asks the server and runs what only reads', async () => {
    const session = server();
    await setUpRedisSession(session, { ...withInit('CLIENT SETNAME app\nPING'), readOnly: true });
    expect(session.calls).toEqual([
      ['COMMAND', 'INFO', 'CLIENT'],
      ['CLIENT', 'SETNAME', 'app'],
      ['COMMAND', 'INFO', 'PING'],
      ['PING'],
    ]);
  });

  it('on a read-only connection refuses a write before running anything', async () => {
    for (const line of ['SET k v', 'CLIENT KILL ID 1', 'MODULECMD x']) {
      const session = server();
      await expect(
        setUpRedisSession(session, { ...withInit(line), readOnly: true }),
        line,
      ).rejects.toMatchObject({ code: 'permission-denied' });
      expect(
        session.calls.every((call) => call[0] === 'COMMAND'),
        line,
      ).toBe(true);
    }
  });

  it('treats a command the server cannot describe as a write on a read-only connection', async () => {
    const session = new FakeRedisSession((words) =>
      words[0] === 'COMMAND' ? new DbError('syntax', 'ERR unknown command') : bulk('OK'),
    );
    await expect(
      setUpRedisSession(session, { ...withInit('PING'), readOnly: true }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('does not ask the server when the connection may write', async () => {
    const session = server();
    await setUpRedisSession(session, withInit('SET k v'));
    expect(session.calls).toEqual([['SET', 'k', 'v']]);
  });
});

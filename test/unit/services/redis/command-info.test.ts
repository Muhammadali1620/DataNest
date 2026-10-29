import { describe, expect, it } from 'vitest';
import type { RedisReply } from '../../../../src/drivers/redis-driver';
import {
  commandEffect,
  commandFor,
  parseCommandEntry,
  parseCommandInfo,
  type RedisCommandInfo,
  SESSION_COMMANDS,
} from '../../../../src/services/redis/command-info';
import { bulk } from '../../../helpers/fake-redis';

/** An entry as `COMMAND INFO` sends it: names and flags as bytes, numbers as text. */
function entry(
  name: string,
  flags: string[],
  categories: string[] = [],
  subcommands: RedisReply[] = [],
): RedisReply {
  return [
    bulk(name),
    '-2',
    flags.map(bulk),
    '1',
    '1',
    '1',
    categories.map(bulk),
    [],
    [],
    subcommands,
  ];
}

const info = (flags: string[], categories: string[] = []): RedisCommandInfo => ({
  name: 'x',
  arity: -1,
  flags,
  categories,
  subcommands: [],
});

describe('parseCommandEntry', () => {
  it('reads name, arity, flags, categories and subcommands, lowercased', () => {
    const parsed = parseCommandEntry(
      entry(
        'CONFIG',
        ['admin'],
        ['@Admin'],
        [entry('config|get', ['admin', 'loading'], ['@slow'])],
      ),
    );
    expect(parsed).toEqual({
      name: 'config',
      arity: -2,
      flags: ['admin'],
      categories: ['@admin'],
      subcommands: [
        {
          name: 'config|get',
          arity: -2,
          flags: ['admin', 'loading'],
          categories: ['@slow'],
          subcommands: [],
        },
      ],
    });
  });

  it('reads an old server without categories or subcommands', () => {
    const parsed = parseCommandEntry([bulk('get'), '2', [bulk('readonly')], '1', '1', '1']);
    expect(parsed).toMatchObject({
      name: 'get',
      flags: ['readonly'],
      categories: [],
      subcommands: [],
    });
  });

  it('is undefined for an unknown command (a nil entry) and for junk', () => {
    expect(parseCommandEntry(null)).toBeUndefined();
    expect(parseCommandEntry(undefined)).toBeUndefined();
    expect(parseCommandEntry([bulk('x')])).toBeUndefined();
    expect(parseCommandEntry(bulk('x'))).toBeUndefined();
  });
});

describe('parseCommandInfo', () => {
  it('keeps the order, with gaps for unknown commands', () => {
    const parsed = parseCommandInfo([entry('get', ['readonly']), null]);
    expect(parsed.map((item) => item?.name)).toEqual(['get', undefined]);
  });

  it('reads nothing from a reply that is no list', () => {
    expect(parseCommandInfo(null)).toEqual([]);
    expect(parseCommandInfo({ error: 'ERR' })).toEqual([]);
  });
});

describe('commandEffect', () => {
  it('calls reading commands reads', () => {
    expect(commandEffect(info(['readonly', 'fast'], ['@read']))).toBe('read');
    expect(commandEffect(info(['fast'], ['@fast', '@connection']))).toBe('read');
    // INFO and KEYS are dangerous to performance, not to data.
    expect(commandEffect(info(['loading', 'stale'], ['@slow', '@dangerous']))).toBe('read');
    expect(commandEffect(info(['readonly', 'noscript'], ['@slow', '@scripting']))).toBe('read');
  });

  it('calls writes, administration, replicated and scripting commands writes', () => {
    expect(commandEffect(info(['write', 'denyoom']))).toBe('write');
    expect(commandEffect(info(['admin', 'noscript']))).toBe('write');
    expect(commandEffect(info(['loading'], ['@admin', '@dangerous']))).toBe('write');
    expect(commandEffect(info(['pubsub', 'may_replicate']))).toBe('write');
    expect(commandEffect(info(['noscript'], ['@write']))).toBe('write');
    expect(commandEffect(info(['noscript', 'skip_monitor'], ['@slow', '@scripting']))).toBe(
      'write',
    );
  });

  it('cannot tell without information', () => {
    expect(commandEffect(undefined)).toBe('unknown');
  });
});

describe('commandFor', () => {
  const config = parseCommandEntry(
    entry(
      'config',
      ['admin'],
      [],
      [entry('config|get', ['loading'], ['@slow']), entry('config|set', ['admin'])],
    ),
  );

  it('picks the subcommand the words name, in any case', () => {
    expect(commandFor(config, ['CONFIG', 'Get', 'maxmemory'])?.name).toBe('config|get');
    expect(commandFor(config, ['config', 'set'])?.name).toBe('config|set');
  });

  it('falls back to the container for an unknown subcommand or none', () => {
    expect(commandFor(config, ['config', 'nope'])?.name).toBe('config');
    expect(commandFor(config, ['config'])?.name).toBe('config');
    expect(commandFor(info([]), ['x', 'y'])?.name).toBe('x');
    expect(commandFor(undefined, ['x'])).toBeUndefined();
  });
});

describe('SESSION_COMMANDS', () => {
  it('names the commands that change the connection itself, in lowercase', () => {
    for (const name of ['select', 'auth', 'hello', 'multi', 'subscribe', 'monitor', 'quit']) {
      expect(SESSION_COMMANDS.has(name)).toBe(true);
    }
    expect(SESSION_COMMANDS.has('get')).toBe(false);
  });
});

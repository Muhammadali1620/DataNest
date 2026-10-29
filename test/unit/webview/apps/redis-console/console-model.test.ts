import { describe, expect, it } from 'vitest';
import type { ConsoleCommandDoc } from '../../../../../src/shared/protocols/redis-console';
import {
  commandOf,
  complete,
  History,
  keyPrefix,
  keyWord,
  MAX_SUGGESTIONS,
  suggestCommands,
  syntaxLine,
  wordsBefore,
} from '../../../../../webview/src/apps/redis-console/console-model';

const doc = (name: string, extra: Partial<ConsoleCommandDoc> = {}): ConsoleCommandDoc => ({
  name,
  keyFirst: false,
  ...extra,
});

const COMMANDS = [
  doc('CONFIG', { summary: 'A container' }),
  doc('CONFIG GET', { syntax: 'parameter [parameter ...]' }),
  doc('CONFIG SET', { syntax: 'parameter value' }),
  doc('GET', { syntax: 'key', keyFirst: true, summary: 'Gets a value' }),
  doc('GETDEL', { syntax: 'key', keyFirst: true }),
  doc('PING'),
];

describe('wordsBefore', () => {
  it('splits the typed words from the one being typed', () => {
    expect(wordsBefore('SET a b')).toEqual({ done: ['SET', 'a'], current: 'b' });
    expect(wordsBefore('SET a ')).toEqual({ done: ['SET', 'a'], current: '' });
    expect(wordsBefore('')).toEqual({ done: [], current: '' });
  });
});

describe('suggestCommands', () => {
  it('offers commands that continue the first word, in any case', () => {
    expect(suggestCommands('ge', COMMANDS).map((one) => one.name)).toEqual(['GET', 'GETDEL']);
    expect(suggestCommands('', COMMANDS)).toEqual([]);
  });

  it('offers subcommands after their container', () => {
    expect(suggestCommands('config ', COMMANDS).map((one) => one.name)).toEqual([
      'CONFIG GET',
      'CONFIG SET',
    ]);
    expect(suggestCommands('config s', COMMANDS).map((one) => one.name)).toEqual(['CONFIG SET']);
  });

  it('offers nothing once arguments are typed', () => {
    expect(suggestCommands('GET user', COMMANDS)).toEqual([]);
    expect(suggestCommands('CONFIG GET max', COMMANDS)).toEqual([]);
  });

  it('shows at most so many', () => {
    const many = Array.from({ length: 80 }, (_v, i) => doc(`X${i}`));
    expect(suggestCommands('x', many)).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe('commandOf / syntaxLine', () => {
  it('finds the subcommand before its container', () => {
    expect(commandOf('config get maxmemory', COMMANDS)?.name).toBe('CONFIG GET');
    expect(commandOf('config', COMMANDS)?.name).toBe('CONFIG');
    expect(commandOf('config nope', COMMANDS)?.name).toBe('CONFIG');
    expect(commandOf('  ', COMMANDS)).toBeUndefined();
    expect(commandOf('unknown', COMMANDS)).toBeUndefined();
  });

  it('writes the command with its arguments', () => {
    expect(syntaxLine(doc('GET', { syntax: 'key' }))).toBe('GET key');
    expect(syntaxLine(doc('PING'))).toBe('PING');
  });
});

describe('keyPrefix', () => {
  it('is the word typed where a key goes', () => {
    expect(keyPrefix('get user:', COMMANDS)).toBe('user:');
    expect(keyPrefix('GET ', COMMANDS)).toBe('');
  });

  it('is undefined elsewhere', () => {
    expect(keyPrefix('get', COMMANDS)).toBeUndefined();
    expect(keyPrefix('get a b', COMMANDS)).toBeUndefined();
    expect(keyPrefix('ping x', COMMANDS)).toBeUndefined();
    expect(keyPrefix('get "us', COMMANDS)).toBeUndefined();
  });
});

describe('complete / keyWord', () => {
  it('replaces the word at the caret, or the container with its subcommand', () => {
    expect(complete('ge', 'GET')).toBe('GET ');
    expect(complete('config s', 'CONFIG SET', 2)).toBe('CONFIG SET ');
    expect(complete('get us', '"user: spaced"')).toBe('get "user: spaced" ');
    expect(complete('get us', 'user:1')).toBe('get user:1 ');
  });

  it('quotes key names with blanks or quotes', () => {
    expect(keyWord('user:1')).toBe('user:1');
    expect(keyWord('key with spaces')).toBe('"key with spaces"');
    expect(keyWord('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(keyWord('')).toBe('""');
  });
});

describe('History', () => {
  it('walks back and forth and returns to what was being typed', () => {
    const history = new History(['one', 'two']);
    expect(history.up('draft')).toBe('two');
    expect(history.up('two')).toBe('one');
    expect(history.up('one')).toBeUndefined();
    expect(history.down()).toBe('two');
    expect(history.down()).toBe('draft');
    expect(history.down()).toBeUndefined();
  });

  it('adds lines without repeating the last one', () => {
    const history = new History([]);
    history.add('a');
    history.add('a');
    history.add('b');
    expect(history.up('')).toBe('b');
    expect(history.up('')).toBe('a');
    expect(history.up('')).toBeUndefined();
  });
});

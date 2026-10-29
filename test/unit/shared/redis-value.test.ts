import { describe, expect, it } from 'vitest';
import {
  hexBytes,
  redisValueBytes,
  redisValueOf,
  sameValue,
} from '../../../src/shared/redis-value';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('redisValueOf', () => {
  it('keeps UTF-8 as text, line breaks and all', () => {
    expect(redisValueOf(utf8('a\nб'))).toEqual({ text: 'a\nб' });
    expect(redisValueOf(utf8(''))).toEqual({ text: '' });
  });

  it('gives bytes that are not UTF-8 as hex, with readable text beside', () => {
    expect(redisValueOf(Uint8Array.of(0, 255, 16))).toEqual({
      text: '\\x00\\xff\\x10',
      hex: '00ff10',
    });
  });

  it('cuts a value past the limit and says how big it is', () => {
    expect(redisValueOf(utf8('abcdef'), 4)).toEqual({ text: 'abcd', truncated: true, size: 6 });
    // The full size may be known apart from the bytes at hand.
    expect(redisValueOf(utf8('ab'), 10, 99)).toEqual({ text: 'ab', truncated: true, size: 99 });
  });

  it('does not split a character when cutting text', () => {
    expect(redisValueOf(utf8('абв'), 3)).toEqual({ text: 'а', truncated: true, size: 6 });
  });
});

describe('redisValueBytes', () => {
  it('encodes text and decodes hex', () => {
    expect(redisValueBytes({ text: 'é' })).toEqual(utf8('é'));
    expect(redisValueBytes({ text: 'ignored', hex: '00ff' })).toEqual(Uint8Array.of(0, 255));
  });

  it('refuses a cut value and broken hex', () => {
    expect(redisValueBytes({ text: 'a', truncated: true })).toBeUndefined();
    expect(redisValueBytes({ text: '', hex: 'abc' })).toBeUndefined();
  });
});

describe('hexBytes', () => {
  it('allows blanks between pairs and both cases', () => {
    expect(hexBytes('0a FF\n10')).toEqual(Uint8Array.of(10, 255, 16));
    expect(hexBytes('')).toEqual(new Uint8Array());
  });

  it('refuses odd lengths and other characters', () => {
    expect(hexBytes('a')).toBeUndefined();
    expect(hexBytes('zz')).toBeUndefined();
  });
});

describe('sameValue', () => {
  it('compares what would be written', () => {
    expect(sameValue({ text: 'a' }, { text: 'a' })).toBe(true);
    expect(sameValue({ text: 'x', hex: '00' }, { text: 'y', hex: '00' })).toBe(true);
    expect(sameValue({ text: 'a' }, { text: 'b' })).toBe(false);
  });
});

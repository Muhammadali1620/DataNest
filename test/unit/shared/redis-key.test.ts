import { describe, expect, it } from 'vitest';
import { displayKey, redisKeyBytes, redisKeyId, redisKeyRef } from '../../../src/shared/redis-key';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('displayKey', () => {
  it('shows UTF-8 as it is, in any script', () => {
    expect(displayKey(utf8('user:имя:🙂'))).toBe('user:имя:🙂');
    expect(displayKey(bytes())).toBe('');
  });

  it('writes broken bytes and control characters as \\xHH', () => {
    expect(displayKey(bytes(0x62, 0x3a, 0xff, 0xfe))).toBe('b:\\xff\\xfe');
    expect(displayKey(bytes(0x61, 0x0a, 0x00, 0x7f))).toBe('a\\x0a\\x00\\x7f');
  });

  it('rejects overlong forms, surrogates and cut sequences', () => {
    expect(displayKey(bytes(0xc0, 0xaf))).toBe('\\xc0\\xaf');
    expect(displayKey(bytes(0xed, 0xa0, 0x80))).toBe('\\xed\\xa0\\x80');
    expect(displayKey(bytes(0xd0))).toBe('\\xd0');
    expect(displayKey(bytes(0xe2, 0x82, 0x41))).toBe('\\xe2\\x82A');
    expect(displayKey(bytes(0xf4, 0x90, 0x80, 0x80))).toBe('\\xf4\\x90\\x80\\x80');
  });
});

describe('redisKeyRef / redisKeyBytes', () => {
  it('keeps a plain key as text only', () => {
    expect(redisKeyRef(utf8('user:1'))).toEqual({ text: 'user:1' });
    expect(redisKeyBytes({ text: 'user:1' })).toEqual(utf8('user:1'));
  });

  it('keeps the exact bytes of a key that is not its text', () => {
    const key = bytes(0x62, 0xff);
    const ref = redisKeyRef(key);
    expect(ref).toEqual({ text: 'b\\xff', hex: '62ff' });
    expect(redisKeyBytes(ref)).toEqual(key);
    // A key whose bytes really are `b\xff` as text stays apart from it.
    expect(redisKeyRef(utf8('b\\xff'))).toEqual({ text: 'b\\xff' });
    expect(redisKeyId(ref)).not.toBe(redisKeyId(redisKeyRef(utf8('b\\xff'))));
  });

  it('round-trips control characters through hex', () => {
    const key = bytes(0x61, 0x0a);
    expect(redisKeyBytes(redisKeyRef(key))).toEqual(key);
  });
});

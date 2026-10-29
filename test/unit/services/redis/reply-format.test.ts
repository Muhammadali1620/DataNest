import { describe, expect, it } from 'vitest';
import { formatReply, quoteBulk } from '../../../../src/services/redis/reply-format';
import { bulk } from '../../../helpers/fake-redis';

const format = (reply: Parameters<typeof formatReply>[0], maxItems = 100) =>
  formatReply(reply, { maxItems });

describe('quoteBulk', () => {
  it('quotes text and escapes what redis-cli escapes', () => {
    expect(quoteBulk(bulk('OK'))).toBe('"OK"');
    expect(quoteBulk(bulk('a"b\\c\nd\r\te\u0001'))).toBe('"a\\"b\\\\c\\nd\\r\\te\\x01"');
    expect(quoteBulk(bulk('Привет'))).toBe('"Привет"');
  });

  it('writes bytes that are not UTF-8 as hex escapes, printable ASCII as it is', () => {
    expect(quoteBulk(Uint8Array.of(0x61, 0xff, 0x22, 0x00))).toBe('"a\\xff\\x22\\x00"');
  });
});

describe('formatReply', () => {
  it('prints scalars as redis-cli does', () => {
    expect(format(null)).toEqual(['(nil)']);
    expect(format('42')).toEqual(['(integer) 42']);
    expect(format(bulk(''))).toEqual(['""']);
    expect(format({ error: 'ERR x' })).toEqual(['(error) ERR x']);
    expect(format([])).toEqual(['(empty array)']);
  });

  it('numbers arrays and indents nested ones', () => {
    expect(format([bulk('a'), [bulk('b'), '2'], null])).toEqual([
      '1) "a"',
      '2) 1) "b"',
      '   2) (integer) 2',
      '3) (nil)',
    ]);
  });

  it('aligns numbers of long arrays', () => {
    const lines = format(Array.from({ length: 10 }, (_v, i) => String(i)));
    expect(lines[0]).toBe(' 1) (integer) 0');
    expect(lines[9]).toBe('10) (integer) 9');
  });

  it('stops after the most items and counts the rest', () => {
    expect(format([bulk('a'), bulk('b'), bulk('c')], 2)).toEqual(['1) "a"', '2) "b"', '(1 more)']);
  });
});

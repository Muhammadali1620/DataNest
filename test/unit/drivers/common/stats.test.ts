import { describe, expect, it } from 'vitest';
import { statComment, statCount, tableStats } from '../../../../src/drivers/common/stats';

describe('statCount', () => {
  it('reads counts whatever type the client library hands them over in', () => {
    expect(statCount(42)).toBe(42);
    expect(statCount(42n)).toBe(42);
    expect(statCount('42')).toBe(42);
    expect(statCount('1234567890123')).toBe(1_234_567_890_123);
    expect(statCount(0)).toBe(0);
  });

  it('rounds estimates that come as fractions', () => {
    expect(statCount(499.6)).toBe(500);
    expect(statCount('12.4')).toBe(12);
  });

  it('treats what the server does not know as absent', () => {
    for (const value of [-1, '-1', null, undefined, Number.NaN, Infinity, 'n/a', '', '1e3', {}]) {
      expect(statCount(value)).toBeUndefined();
    }
  });
});

describe('statComment', () => {
  it('keeps a comment as written', () => {
    expect(statComment(' Staff of the shop ')).toBe(' Staff of the shop ');
  });

  it('drops empty and blank comments and anything that is not text', () => {
    for (const value of ['', '   ', '\n', null, undefined, 1]) {
      expect(statComment(value)).toBeUndefined();
    }
  });
});

describe('tableStats', () => {
  it('keeps what the server knows', () => {
    expect(tableStats('orders', '1200', 65536, 'All orders')).toEqual({
      name: 'orders',
      rows: 1200,
      bytes: 65536,
      comment: 'All orders',
    });
  });

  it('leaves out what it does not, and a size of zero', () => {
    expect(tableStats('v', null, null, null)).toEqual({ name: 'v' });
    expect(tableStats('t', -1, 0, '')).toEqual({ name: 't' });
    expect(tableStats('empty', 0, 0, undefined)).toEqual({ name: 'empty', rows: 0 });
  });
});

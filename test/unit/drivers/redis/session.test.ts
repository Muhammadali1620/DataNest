import { describe, expect, it } from 'vitest';
import { normalizeReply } from '../../../../src/drivers/redis/session';

describe('normalizeReply', () => {
  it('keeps bytes and integer text, and makes nil null', () => {
    const bytes = Buffer.from([0, 255]);
    expect(normalizeReply(bytes)).toBe(bytes);
    expect(normalizeReply('42')).toBe('42');
    expect(normalizeReply(null)).toBeNull();
    expect(normalizeReply(undefined)).toBeNull();
  });

  it('writes numbers as text, so nothing reads them as a rounded double later', () => {
    expect(normalizeReply(7)).toBe('7');
    expect(normalizeReply(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('turns errors inside arrays into error replies, nested arrays included', () => {
    expect(normalizeReply([Buffer.from('OK'), new Error('WRONGTYPE x'), [null, 1]])).toEqual([
      Buffer.from('OK'),
      { error: 'WRONGTYPE x' },
      [null, '1'],
    ]);
  });

  it('writes anything else as text', () => {
    expect(normalizeReply(true)).toBe('true');
  });
});

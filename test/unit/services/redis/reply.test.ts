import { describe, expect, it } from 'vitest';
import { replyItems, replyNumber, replyText } from '../../../../src/services/redis/reply';
import { bulk } from '../../../helpers/fake-redis';

describe('replyText', () => {
  it('decodes bytes, keeps integers, and is empty for nil', () => {
    expect(replyText(bulk('Привет'))).toBe('Привет');
    expect(replyText('42')).toBe('42');
    expect(replyText(null)).toBe('');
  });

  it('gives an error its text and joins arrays', () => {
    expect(replyText({ error: 'ERR x' })).toBe('ERR x');
    expect(replyText([bulk('a'), '1', null])).toBe('a 1 ');
  });
});

describe('replyNumber', () => {
  it('reads integers and numbers sent as text', () => {
    expect(replyNumber('-5')).toBe(-5);
    expect(replyNumber(bulk('85.5'))).toBe(85.5);
  });

  it('is undefined for anything else', () => {
    expect(replyNumber(bulk('abc'))).toBeUndefined();
    expect(replyNumber(null)).toBeUndefined();
    expect(replyNumber([])).toBeUndefined();
    expect(replyNumber({ error: 'x' })).toBeUndefined();
  });
});

describe('replyItems', () => {
  it('lists an array and nothing for the rest', () => {
    expect(replyItems(['1', null])).toEqual(['1', null]);
    expect(replyItems(bulk('x'))).toEqual([]);
  });
});

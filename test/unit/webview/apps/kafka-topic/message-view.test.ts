import { describe, expect, it } from 'vitest';
import {
  fillPercent,
  isOffset,
  parseHeaders,
  partitionSize,
  timeText,
  totalMessages,
} from '../../../../../webview/src/apps/kafka-topic/message-view';

const part = (low: string, high: string) => ({ low, high });

describe('partition sizes', () => {
  it('counts the messages between the offsets, exactly even past 2^53', () => {
    expect(partitionSize(part('0', '0'))).toBe(0n);
    expect(partitionSize(part('4', '10'))).toBe(6n);
    expect(partitionSize(part('9007199254740993', '9007199254741003'))).toBe(10n);
  });

  it('never counts below zero', () => {
    expect(partitionSize(part('10', '4'))).toBe(0n);
  });

  it('adds the partitions up', () => {
    expect(totalMessages([part('0', '3'), part('2', '4'), part('0', '0')])).toBe(5n);
    expect(totalMessages([])).toBe(0n);
  });

  it('fills the bar next to the fullest partition', () => {
    const all = [part('0', '10'), part('0', '5'), part('0', '0')];
    expect(all.map((one) => fillPercent(one, all))).toEqual([100, 50, 0]);
    expect(fillPercent(part('0', '0'), [part('0', '0')])).toBe(0);
  });
});

describe('timeText', () => {
  it('writes a message time in 24-hour local form', () => {
    expect(timeText('1700000000000', 'en-GB')).toMatch(/2023/u);
  });

  it('keeps text that is not a time', () => {
    expect(timeText('soon')).toBe('soon');
    expect(timeText('-5')).toBe('-5');
  });
});

describe('parseHeaders', () => {
  it('reads name: value lines and skips blank ones', () => {
    expect(parseHeaders('trace: 42\n\n  a :b:c  \r\nflag')).toEqual([
      { name: 'trace', value: '42' },
      { name: 'a', value: 'b:c' },
      { name: 'flag', value: '' },
    ]);
    expect(parseHeaders('')).toEqual([]);
  });
});

describe('isOffset', () => {
  it('takes whole numbers only', () => {
    expect(isOffset('12')).toBe(true);
    expect(isOffset(' 0 ')).toBe(true);
    for (const text of ['', '-1', '1.5', '1e3', 'abc']) {
      expect(isOffset(text)).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { formatDuration, formatWhen, summaryLine } from '../../../src/services/history-format';

describe('summaryLine', () => {
  it('puts the statement on one line', () => {
    expect(summaryLine('SELECT *\n  FROM   users\r\n WHERE id = 1')).toBe(
      'SELECT * FROM users WHERE id = 1',
    );
  });

  it('cuts a long statement with an ellipsis within the limit', () => {
    const line = summaryLine('SELECT '.repeat(50), 20);
    expect(line).toHaveLength(20);
    expect(line.endsWith('…')).toBe(true);
  });

  it('leaves a statement of exactly the limit whole', () => {
    expect(summaryLine('x'.repeat(90))).toBe('x'.repeat(90));
  });

  it('copes with nothing', () => {
    expect(summaryLine('  \n ')).toBe('');
  });
});

describe('formatDuration', () => {
  it('picks the unit that reads best', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(45)).toBe('45 ms');
    expect(formatDuration(999.4)).toBe('999 ms');
    expect(formatDuration(1200)).toBe('1.2 s');
    expect(formatDuration(9990)).toBe('10.0 s');
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(185_000)).toBe('3 min 5 s');
    expect(formatDuration(7_440_000)).toBe('2 h 4 min');
  });

  it('does not go below zero', () => {
    expect(formatDuration(-5)).toBe('0 ms');
  });
});

describe('formatWhen', () => {
  const at = (y: number, m: number, d: number, h: number, min: number): number =>
    new Date(y, m - 1, d, h, min).getTime();

  it('shows only the time for today', () => {
    expect(formatWhen(at(2026, 10, 28, 9, 5), at(2026, 10, 28, 18, 0))).toBe('09:05');
  });

  it('adds the date for another day, including the same day of another month or year', () => {
    expect(formatWhen(at(2026, 10, 27, 14, 5), at(2026, 10, 28, 8, 0))).toBe('2026-10-27 14:05');
    expect(formatWhen(at(2026, 9, 28, 14, 5), at(2026, 10, 28, 8, 0))).toBe('2026-09-28 14:05');
    expect(formatWhen(at(2025, 10, 28, 14, 5), at(2026, 10, 28, 8, 0))).toBe('2025-10-28 14:05');
  });
});

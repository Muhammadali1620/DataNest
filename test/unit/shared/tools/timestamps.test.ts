import { describe, expect, it } from 'vitest';
import {
  formatIso,
  formatLocal,
  parseDate,
  parseUnix,
} from '../../../../src/shared/tools/timestamps';

describe('parseUnix', () => {
  it('reads seconds and milliseconds by their length', () => {
    expect(parseUnix('1793436813')).toBe(1_793_436_813_000);
    expect(parseUnix('1793436813005')).toBe(1_793_436_813_005);
    expect(parseUnix(' 0 ')).toBe(0);
    expect(parseUnix('-86400')).toBe(-86_400_000);
  });

  it('reads fractional seconds', () => {
    expect(parseUnix('1793436813.25')).toBe(1_793_436_813_250);
  });

  it.each(['', 'abc', '12abc', '1e9', '--1', '1.2.3'])('refuses %j', (text) => {
    expect(parseUnix(text)).toBeUndefined();
  });

  it('refuses a time past the range of a date', () => {
    expect(parseUnix('99999999999999999999')).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formats local and ISO times', () => {
    const date = new Date(2026, 9, 31, 13, 5, 9);
    expect(formatLocal(date.getTime())).toBe('2026-10-31 13:05:09');
    expect(formatIso(Date.UTC(2026, 9, 31, 13, 5, 9))).toBe('2026-10-31T13:05:09.000Z');
  });

  it('answers undefined for an impossible time', () => {
    expect(formatLocal(Number.NaN)).toBeUndefined();
    expect(formatIso(9e15)).toBeUndefined();
  });
});

describe('parseDate', () => {
  it('reads a date and a date with time as local time', () => {
    expect(parseDate('2026-10-31')).toBe(new Date(2026, 9, 31).getTime());
    expect(parseDate('2026-10-31 13:05')).toBe(new Date(2026, 9, 31, 13, 5).getTime());
    expect(parseDate('2026-10-31T13:05:09')).toBe(new Date(2026, 9, 31, 13, 5, 9).getTime());
    expect(parseDate('2026-10-31 13:05:09.5')).toBe(new Date(2026, 9, 31, 13, 5, 9, 500).getTime());
  });

  it('reads ISO text with a zone', () => {
    expect(parseDate('2026-10-31T13:05:09Z')).toBe(Date.UTC(2026, 9, 31, 13, 5, 9));
    expect(parseDate('2026-10-31T13:05:09+03:00')).toBe(Date.UTC(2026, 9, 31, 10, 5, 9));
  });

  it('round-trips with formatLocal', () => {
    const ms = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(parseDate(formatLocal(ms) ?? '')).toBe(ms);
  });

  it.each([
    '',
    'yesterday',
    '2026-02-30',
    '2026-13-01',
    '31.10.2026',
    '2026-10-31T13:05:09+99:99x',
  ])('refuses %j', (text) => {
    expect(parseDate(text)).toBeUndefined();
  });
});

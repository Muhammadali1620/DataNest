import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  isoOf,
  MAX_RANGE_MS,
  nowNs,
  parseDuration,
  parseInstant,
  resolveWindow,
} from '../../../../src/drivers/loki/time';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const NOW_NS = nowNs(NOW);

describe('parseDuration', () => {
  it('reads every unit and sums a compound', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1w')).toBe(604_800_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration(' 5m ')).toBe(300_000);
  });

  it('refuses text that is not a duration, and zero', () => {
    for (const text of ['', 'h', '1', '1x', '-5m', '1.5h', 'five minutes', '0s', '1h 30m']) {
      expect(parseDuration(text), text).toBeUndefined();
    }
  });
});

describe('parseInstant', () => {
  it('knows now and now minus a duration', () => {
    expect(parseInstant('now', NOW)).toBe(NOW_NS);
    expect(parseInstant('NOW', NOW)).toBe(NOW_NS);
    expect(parseInstant('now-1h', NOW)).toBe(NOW_NS - 3_600_000_000_000n);
    expect(parseInstant('now - 30m', NOW)).toBe(NOW_NS - 1_800_000_000_000n);
    expect(parseInstant('now-abc', NOW)).toBeUndefined();
  });

  it('tells seconds, milliseconds, microseconds and nanoseconds apart by their size', () => {
    expect(parseInstant('1730000000', NOW)).toBe(1_730_000_000_000_000_000n);
    expect(parseInstant('1730000000123', NOW)).toBe(1_730_000_000_123_000_000n);
    expect(parseInstant('1730000000123456', NOW)).toBe(1_730_000_000_123_456_000n);
    expect(parseInstant('1730000000123456789', NOW)).toBe(1_730_000_000_123_456_789n);
  });

  it('reads seconds with a fraction without a rounding error', () => {
    expect(parseInstant('1730000000.5', NOW)).toBe(1_730_000_000_500_000_000n);
    expect(parseInstant('1730000000.123456789', NOW)).toBe(1_730_000_000_123_456_789n);
    // More digits than nanoseconds are cut, not rounded.
    expect(parseInstant('1730000000.1234567899', NOW)).toBe(1_730_000_000_123_456_789n);
  });

  it('reads RFC 3339 with and without a fraction and a zone', () => {
    expect(parseInstant('2026-11-02T12:00:00Z', NOW)).toBe(NOW_NS);
    expect(parseInstant('2026-11-02T12:00:00.123Z', NOW)).toBe(NOW_NS + 123_000_000n);
    expect(parseInstant('2026-11-02T12:00:00.123456789Z', NOW)).toBe(NOW_NS + 123_456_789n);
    expect(parseInstant('2026-11-02T17:00:00+05:00', NOW)).toBe(NOW_NS);
    expect(parseInstant('2026-11-02', NOW)).toBe(nowNs(new Date('2026-11-02T00:00:00Z')));
  });

  it('refuses what it cannot read', () => {
    for (const text of ['', 'yesterday', '2026-13-45T00:00:00Z', 'abc', '12:00']) {
      expect(parseInstant(text, NOW), text).toBeUndefined();
    }
  });
});

describe('resolveWindow', () => {
  it('ends now and starts a range before it', () => {
    expect(resolveWindow({ range: '1h' }, '6h', NOW)).toEqual({
      startNs: NOW_NS - 3_600_000_000_000n,
      endNs: NOW_NS,
    });
  });

  it('falls back to the default range', () => {
    expect(resolveWindow({}, '15m', NOW)).toEqual({
      startNs: NOW_NS - 900_000_000_000n,
      endNs: NOW_NS,
    });
  });

  it('takes a start and an end of its own, and they win over the range', () => {
    const window = resolveWindow(
      { range: '1h', start: '2026-11-01T00:00:00Z', end: '2026-11-01T06:00:00Z' },
      '1h',
      NOW,
    );
    expect(window.endNs - window.startNs).toBe(6n * 3_600_000_000_000n);
  });

  it('measures a range back from an end of its own', () => {
    const window = resolveWindow({ range: '30m', end: 'now-1h' }, '1h', NOW);
    expect(window.endNs).toBe(NOW_NS - 3_600_000_000_000n);
    expect(window.startNs).toBe(window.endNs - 1_800_000_000_000n);
  });

  it('says what is wrong with a bad range, start or end', () => {
    const syntax = { code: 'syntax' };
    expect(() => resolveWindow({ range: 'soon' }, '1h', NOW)).toThrow(DbError);
    expect(() => resolveWindow({ range: 'soon' }, '1h', NOW)).toThrow(/range of time/u);
    expect(() => resolveWindow({ start: 'x' }, '1h', NOW)).toThrow(/not a time/u);
    expect(() => resolveWindow({ end: 'x' }, '1h', NOW)).toThrow(/not a time/u);
    try {
      resolveWindow({ range: 'soon' }, '1h', NOW);
    } catch (error) {
      expect(error).toMatchObject(syntax);
    }
  });

  it('refuses a start that is not before the end, and a range longer than a year', () => {
    expect(() => resolveWindow({ start: 'now', end: 'now-1h' }, '1h', NOW)).toThrow(
      /not before its end/u,
    );
    expect(() => resolveWindow({ start: 'now', end: 'now' }, '1h', NOW)).toThrow(
      /not before its end/u,
    );
    expect(() => resolveWindow({ range: '400d' }, '1h', NOW)).toThrow(/range of time/u);
    expect(MAX_RANGE_MS).toBe(366 * 86_400_000);
  });

  it('uses the clock when no time is given', () => {
    const window = resolveWindow({ range: '1h' }, '1h');
    expect(window.endNs - window.startNs).toBe(3_600_000_000_000n);
  });
});

describe('isoOf', () => {
  it('writes a stamp at the precision of a date', () => {
    expect(isoOf(NOW_NS)).toBe('2026-11-02T12:00:00.000Z');
    expect(isoOf(NOW_NS + 123_999_999n)).toBe('2026-11-02T12:00:00.123Z');
  });
});

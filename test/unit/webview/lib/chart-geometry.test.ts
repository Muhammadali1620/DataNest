import { describe, expect, it } from 'vitest';
import {
  areaPath,
  axisTimes,
  byteUnit,
  clockLabel,
  nearestIndex,
  niceScale,
  smoothPath,
  timeX,
  windowFor,
} from '../../../../webview/src/lib/chart-geometry';

describe('niceScale', () => {
  it.each([
    [0.9, 4, 1, [0, 0.25, 0.5, 0.75, 1]],
    [6, 4, 6, [0, 2, 4, 6]],
    [9.5, 4, 10, [0, 2.5, 5, 7.5, 10]],
    [10_000, 4, 10_000, [0, 2500, 5000, 7500, 10_000]],
    [1, 4, 1, [0, 0.25, 0.5, 0.75, 1]],
  ])('holds %d in %d steps: top %d', (highest, count, max, ticks) => {
    const scale = niceScale(highest, count);
    expect(scale.max).toBe(max);
    expect(scale.ticks).toEqual(ticks);
  });

  it('gives a flat zero or a broken number a range of one', () => {
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(niceScale(value).max).toBe(1);
    }
  });

  it('always reaches the highest value and starts at zero', () => {
    for (const value of [0.013, 0.7, 3, 7.3, 42, 999, 123_456, 9.9e9]) {
      const scale = niceScale(value);
      expect(scale.max).toBeGreaterThanOrEqual(value);
      expect(scale.ticks[0]).toBe(0);
      expect(scale.ticks.at(-1)).toBe(scale.max);
    }
  });
});

describe('smoothPath', () => {
  it('draws nothing for no points and a start for one', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([{ x: 1, y: 2 }])).toBe('M1,2');
  });

  it('goes through every point', () => {
    const path = smoothPath([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 20, y: 5 },
    ]);
    expect(path.startsWith('M0,10C')).toBe(true);
    expect(path).toContain(' 10,0');
    expect(path.endsWith(' 20,5')).toBe(true);
  });

  it('never leaves the band of its data: a flat stretch stays flat', () => {
    const path = smoothPath([
      { x: 0, y: 50 },
      { x: 10, y: 50 },
      { x: 20, y: 0 },
      { x: 30, y: 50 },
      { x: 40, y: 50 },
    ]);
    const ys = [...path.matchAll(/(?:[MC ]|^)(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) =>
      Number(m[2]),
    );
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(50);
    // The control points beside a flat piece lie on it.
    expect(path.startsWith('M0,50C3.33,50 ')).toBe(true);
  });

  it('copes with points on the same x', () => {
    expect(() =>
      smoothPath([
        { x: 5, y: 1 },
        { x: 5, y: 9 },
      ]),
    ).not.toThrow();
  });
});

describe('areaPath', () => {
  it('closes the curve down to the baseline', () => {
    const area = areaPath(
      [
        { x: 0, y: 10 },
        { x: 10, y: 0 },
      ],
      20,
    );
    expect(area.endsWith('L10,20L0,20Z')).toBe(true);
    expect(areaPath([], 20)).toBe('');
  });
});

describe('time on the axis', () => {
  it('places the end of the window at the right edge and its start at the left', () => {
    expect(timeX(1000, 1000, 600, 50, 450)).toBe(450);
    expect(timeX(400, 1000, 600, 50, 450)).toBe(50);
    expect(timeX(700, 1000, 600, 50, 450)).toBe(250);
  });

  it('keeps a time outside the window on the edge', () => {
    expect(timeX(0, 1000, 600, 50, 450)).toBe(50);
    expect(timeX(2000, 1000, 600, 50, 450)).toBe(450);
    expect(timeX(5, 1000, 0, 50, 450)).toBe(450);
  });

  it('spreads label times evenly over the window', () => {
    expect(axisTimes(1000, 600, 4)).toEqual([400, 600, 800, 1000]);
    expect(axisTimes(1000, 600, 1)).toEqual([1000]);
  });

  it('writes a clock as hours, minutes and seconds', () => {
    expect(clockLabel(new Date(2026, 9, 31, 20, 57, 9).getTime(), 'en-GB')).toBe('20:57:09');
  });

  it('spans what the readings cover, within the least and most', () => {
    expect(windowFor([], 60, 300)).toBe(60);
    expect(windowFor([1000], 60, 300)).toBe(60);
    expect(windowFor([0, 100], 60, 300)).toBe(100);
    expect(windowFor([0, 1000], 60, 300)).toBe(300);
  });
});

describe('nearestIndex', () => {
  it('finds the closest sample', () => {
    expect(nearestIndex([10, 20, 30], 26)).toBe(2);
    expect(nearestIndex([10, 20, 30], 14)).toBe(0);
    expect(nearestIndex([10, 20, 30], -50)).toBe(0);
  });

  it('has none without samples', () => {
    expect(nearestIndex([], 5)).toBeUndefined();
  });
});

describe('byteUnit', () => {
  it('counts in the largest unit the highest value reaches', () => {
    expect(byteUnit(0)).toEqual({ divisor: 1, suffix: 'B' });
    expect(byteUnit(1023)).toEqual({ divisor: 1, suffix: 'B' });
    expect(byteUnit(1024)).toEqual({ divisor: 1024, suffix: 'KB' });
    expect(byteUnit(3 * 1024 * 1024)).toEqual({ divisor: 1024 ** 2, suffix: 'MB' });
    expect(byteUnit(5 * 1024 ** 3)).toEqual({ divisor: 1024 ** 3, suffix: 'GB' });
    expect(byteUnit(1e20).suffix).toBe('TB');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMN_LIMIT,
  DEFAULT_LOOK,
  densityOfHeight,
  isRowDensity,
  lookFromSettings,
  MAX_COLUMN_LIMIT,
  MIN_COLUMN_LIMIT,
  normalizeColumnLimit,
  ROW_DENSITIES,
  ROW_DENSITY_HEIGHT,
} from '../../../src/shared/results-look';

describe('row densities', () => {
  it('goes from tight to roomy, with the old height in the middle', () => {
    const heights = ROW_DENSITIES.map((density) => ROW_DENSITY_HEIGHT[density]);
    expect(heights).toEqual([24, 32, 40]);
    expect(DEFAULT_LOOK.rowHeight).toBe(ROW_DENSITY_HEIGHT.normal);
  });

  it('recognises its own names only', () => {
    expect(isRowDensity('compact')).toBe(true);
    expect(isRowDensity('Compact')).toBe(false);
    expect(isRowDensity(32)).toBe(false);
    expect(isRowDensity(undefined)).toBe(false);
  });

  it('names the density of a height, if it is one of the three', () => {
    expect(densityOfHeight(24)).toBe('compact');
    expect(densityOfHeight(32)).toBe('normal');
    expect(densityOfHeight(40)).toBe('comfortable');
    expect(densityOfHeight(36)).toBeUndefined();
  });
});

describe('normalizeColumnLimit', () => {
  it('keeps a value inside the range, rounded', () => {
    expect(normalizeColumnLimit(640)).toBe(640);
    expect(normalizeColumnLimit(300.4)).toBe(300);
    expect(normalizeColumnLimit(MIN_COLUMN_LIMIT)).toBe(MIN_COLUMN_LIMIT);
    expect(normalizeColumnLimit(MAX_COLUMN_LIMIT)).toBe(MAX_COLUMN_LIMIT);
  });

  it('pulls a value outside the range to its edge', () => {
    expect(normalizeColumnLimit(0)).toBe(MIN_COLUMN_LIMIT);
    expect(normalizeColumnLimit(-50)).toBe(MIN_COLUMN_LIMIT);
    expect(normalizeColumnLimit(1_000_000)).toBe(MAX_COLUMN_LIMIT);
  });

  it('falls back to the default for anything that is not a number', () => {
    for (const value of [undefined, null, '640', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(normalizeColumnLimit(value)).toBe(DEFAULT_COLUMN_LIMIT);
    }
  });
});

describe('lookFromSettings', () => {
  it('turns the two settings into pixels', () => {
    expect(lookFromSettings('compact', 300)).toEqual({ rowHeight: 24, maxColumnWidth: 300 });
    expect(lookFromSettings('comfortable', 900)).toEqual({ rowHeight: 40, maxColumnWidth: 900 });
  });

  it('is the old look for settings nobody touched', () => {
    expect(lookFromSettings('normal', 420)).toEqual(DEFAULT_LOOK);
    expect(lookFromSettings(undefined, undefined)).toEqual(DEFAULT_LOOK);
  });

  it('survives a hand-edited settings file', () => {
    expect(lookFromSettings('huge', 'wide')).toEqual(DEFAULT_LOOK);
    expect(lookFromSettings(7, 5)).toEqual({ rowHeight: 32, maxColumnWidth: MIN_COLUMN_LIMIT });
  });
});

import { describe, expect, it } from 'vitest';
import type { QueryPlanRow } from '../../../../../src/shared/protocols/query-plan';
import {
  formatMs,
  formatNumber,
  parentOf,
  percent,
  rowsText,
  visibleRows,
} from '../../../../../webview/src/apps/query-plan/plan-view';

const row = (
  depth: number,
  descendants: number,
  extra: Partial<QueryPlanRow> = {},
): QueryPlanRow => ({
  depth,
  operation: 'op',
  warnings: [],
  properties: [],
  self: 0,
  share: 0,
  heat: 'none',
  descendants,
  ...extra,
});

// A ─┬ B ── C
//    └ D
const rows = [row(0, 3), row(1, 1), row(2, 0), row(1, 0)];

describe('visibleRows', () => {
  it('shows everything when nothing is collapsed', () => {
    expect(visibleRows(rows, new Set())).toEqual([0, 1, 2, 3]);
  });

  it('hides what is under a collapsed row', () => {
    expect(visibleRows(rows, new Set([1]))).toEqual([0, 1, 3]);
    expect(visibleRows(rows, new Set([0]))).toEqual([0]);
    expect(visibleRows(rows, new Set([2]))).toEqual([0, 1, 2, 3]);
  });
});

describe('parentOf', () => {
  it('finds the row above in the tree', () => {
    expect(parentOf(rows, 2)).toBe(1);
    expect(parentOf(rows, 3)).toBe(0);
    expect(parentOf(rows, 0)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('writes numbers with few digits after the point', () => {
    expect(formatNumber(1450, 'en')).toBe('1,450');
    expect(formatNumber(24.567, 'en')).toBe('24.57');
    expect(formatNumber(0.00708028, 'en')).toBe('0.0071');
    expect(formatNumber(123.4, 'en')).toBe('123');
    expect(formatNumber(undefined)).toBe('');
  });

  it('writes times in ms or s', () => {
    expect(formatMs(0.476, 'en')).toBe('0.476 ms');
    expect(formatMs(12.34, 'en')).toBe('12.3 ms');
    expect(formatMs(1534, 'en')).toBe('1.53 s');
    expect(formatMs(undefined)).toBe('');
  });

  it('writes rows as estimate, then the real number', () => {
    expect(rowsText(row(0, 0, { rows: 1450 }), 'en')).toBe('1,450');
    expect(rowsText(row(0, 0, { rows: 1450, actualRows: 12 }), 'en')).toBe('1,450 → 12');
    expect(rowsText(row(0, 0, { actualRows: 4 }), 'en')).toBe('4');
    expect(rowsText(row(0, 0), 'en')).toBe('');
  });

  it('writes shares as whole percents', () => {
    expect(percent(0.276)).toBe('28%');
    expect(percent(0)).toBe('0%');
  });
});

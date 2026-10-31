import { describe, expect, it } from 'vitest';
import { runSteps } from '../../../src/shared/merge-sort';
import { type CellSummary, exactText, summarySteps } from '../../../src/shared/cell-summary';
import type { CellValue } from '../../../src/shared/cell-value';

const decimal = (text: string): CellValue => ({ kind: 'decimal', text });
const bigint = (text: string): CellValue => ({ kind: 'bigint', text });

function summary(
  rows: CellValue[][],
  columns = [0],
  top = 0,
  bottom = rows.length - 1,
): CellSummary | undefined {
  return runSteps(
    summarySteps((offset, count) => rows.slice(offset, offset + count), top, bottom, columns),
  );
}

describe('summarySteps', () => {
  it('counts cells and values, and adds whole numbers exactly', () => {
    expect(summary([[1], [2], [null], [3]])).toEqual({
      cells: 4,
      values: 3,
      numbers: 3,
      sum: '6',
      average: '2',
      min: '1',
      max: '3',
    });
  });

  it('adds decimals without a floating-point error, keeping their places', () => {
    const result = summary([[decimal('0.10')], [decimal('0.20')], [decimal('-0.05')]]);
    expect(result).toMatchObject({ sum: '0.25', min: '-0.05', max: '0.20', average: '0.08333333' });
    expect(result?.approximate).toBeUndefined();
  });

  it('adds numbers past the safe integer range exactly', () => {
    const result = summary([[bigint('9007199254740993')], [bigint('9007199254740993')]]);
    expect(result).toMatchObject({ sum: '18014398509481986', max: '9007199254740993' });
  });

  it('rounds the average half away from zero and drops trailing zeros', () => {
    expect(summary([[1], [2]])?.average).toBe('1.5');
    expect(summary([[decimal('-1')], [decimal('-2')], [decimal('0')]])?.average).toBe('-1');
    expect(summary([[1], [1], [2]])?.average).toBe('1.333333');
    expect(summary([[2], [2], [1]])?.average).toBe('1.666667');
  });

  it('falls back to doubles when a value is a fraction held as a double', () => {
    const result = summary([[0.1], [0.2], [1]]);
    expect(result).toMatchObject({ approximate: true, numbers: 3, min: '0.1', max: '1' });
    expect(Number(result?.sum)).toBeCloseTo(1.3);
  });

  it('compares exact and double values when finding the smallest and largest', () => {
    expect(summary([[decimal('2.5')], [0.5], [3]])).toMatchObject({ min: '0.5', max: '3' });
  });

  it('counts text, dates and booleans as values but adds only numbers', () => {
    const result = summary([['abc'], [{ kind: 'datetime', text: '2024-01-01' }], [true], [5]]);
    expect(result).toMatchObject({ cells: 4, values: 4, numbers: 1, sum: '5' });
  });

  it('gives only counts when nothing is a number', () => {
    expect(summary([['a'], [null]])).toEqual({ cells: 2, values: 1, numbers: 0 });
    expect(summary([[null]])).toEqual({ cells: 1, values: 0, numbers: 0 });
  });

  it('leaves out numbers that are not finite', () => {
    expect(
      summary([[Number.NaN], [Number.POSITIVE_INFINITY], [decimal('NaN')], [1]]),
    ).toMatchObject({ values: 4, numbers: 1, sum: '1' });
  });

  it('takes only the columns and rows asked for', () => {
    const rows = [
      [1, 10, 100],
      [2, 20, 200],
      [3, 30, 300],
    ];
    expect(summary(rows, [0, 2], 1, 2)).toMatchObject({ cells: 4, sum: '505' });
    expect(summary(rows, [5])).toEqual({ cells: 3, values: 0, numbers: 0 });
  });

  it('reads big selections a batch at a time, yielding between them', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => [index]);
    const reads: number[] = [];
    const steps = summarySteps(
      (offset, count) => {
        reads.push(count);
        return rows.slice(offset, offset + count);
      },
      0,
      4999,
      [0],
    );
    let yields = 0;
    let next = steps.next();
    while (next.done !== true) {
      yields++;
      next = steps.next();
    }
    expect(yields).toBeGreaterThan(1);
    expect(reads.reduce((sum, count) => sum + count, 0)).toBe(5000);
    expect(next.value).toMatchObject({ sum: String((4999 * 5000) / 2), numbers: 5000 });
  });

  it('stops early when the rows run out, and gives up when they are gone', () => {
    expect(summary([[1], [2]], [0], 0, 10)).toMatchObject({ cells: 2, sum: '3' });
    expect(runSteps(summarySteps(() => undefined, 0, 3, [0]))).toBeUndefined();
  });
});

describe('exactText', () => {
  it('writes a scaled number with all its places', () => {
    expect(exactText({ value: -1250n, scale: 2 })).toBe('-12.50');
    expect(exactText({ value: 5n, scale: 3 })).toBe('0.005');
    expect(exactText({ value: -5n, scale: 1 })).toBe('-0.5');
    expect(exactText({ value: 42n, scale: 0 })).toBe('42');
  });
});

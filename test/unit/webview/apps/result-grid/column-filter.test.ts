import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import type { TableFilter } from '../../../../../src/shared/table-filter';
import {
  conditionOn,
  distinctValues,
  filteredColumnNames,
  MAX_DISTINCT_VALUES,
  withColumnCondition,
} from '../../../../../webview/src/apps/result-grid/column-filter';

describe('distinctValues', () => {
  it('lists each value once, in the order it first appears, without NULL', () => {
    const rows: CellValue[][] = [['b'], ['a'], [null], ['b'], ['c']];
    expect(distinctValues(rows, 0)).toEqual({ values: ['b', 'a', 'c'], more: false });
  });

  it('reads the column asked for and skips rows that have not arrived', () => {
    const rows = [[1, 'x'], undefined, [2, 'y'], [3]];
    expect(distinctValues(rows, 1).values).toEqual(['x', 'y']);
  });

  it('writes numbers, booleans and tagged values as the grid shows them', () => {
    const rows: CellValue[][] = [[1], [true], [{ kind: 'json', text: '{"a":1}' }]];
    expect(distinctValues(rows, 0).values).toEqual(['1', 'true', '{"a":1}']);
  });

  it('stops at the limit and says there are more', () => {
    const rows: CellValue[][] = Array.from({ length: 10 }, (_, index) => [index]);
    expect(distinctValues(rows, 0, 4)).toEqual({ values: ['0', '1', '2', '3'], more: true });
  });

  it('does not say there are more when exactly the limit exists', () => {
    const rows: CellValue[][] = Array.from({ length: 4 }, (_, index) => [index]);
    expect(distinctValues(rows, 0, 4).more).toBe(false);
  });

  it('cuts a very long value so the list stays readable', () => {
    const [value] = distinctValues([['x'.repeat(500)]], 0).values;
    expect(value?.length).toBe(120);
  });

  it('has a limit that fits a popover', () => {
    expect(MAX_DISTINCT_VALUES).toBe(200);
  });

  it('is empty for no rows', () => {
    expect(distinctValues([], 0)).toEqual({ values: [], more: false });
  });
});

describe('conditionOn and filteredColumnNames', () => {
  const filter: TableFilter = {
    conditions: [
      { column: 'name', operator: 'contains', value: 'a' },
      { column: 'age', operator: 'gt', value: '3' },
    ],
  };

  it('finds the condition of a column', () => {
    expect(conditionOn(filter, 'age')).toEqual({ column: 'age', operator: 'gt', value: '3' });
    expect(conditionOn(filter, 'other')).toBeUndefined();
    expect(conditionOn(undefined, 'age')).toBeUndefined();
  });

  it('names the filtered columns', () => {
    expect([...filteredColumnNames(filter)]).toEqual(['name', 'age']);
    expect(filteredColumnNames(undefined).size).toBe(0);
  });
});

describe('withColumnCondition', () => {
  const base: TableFilter = {
    conditions: [
      { column: 'name', operator: 'contains', value: 'a' },
      { column: 'age', operator: 'gt', value: '3' },
    ],
    where: 'active',
  };

  it('replaces the column’s condition and keeps the others and the WHERE', () => {
    expect(withColumnCondition(base, 'age', { operator: 'eq', value: '5' })).toEqual({
      conditions: [
        { column: 'name', operator: 'contains', value: 'a' },
        { column: 'age', operator: 'eq', value: '5' },
      ],
      where: 'active',
    });
  });

  it('adds a condition to a table without a filter', () => {
    expect(withColumnCondition(undefined, 'id', { operator: 'eq', value: '7' })).toEqual({
      conditions: [{ column: 'id', operator: 'eq', value: '7' }],
    });
  });

  it('sends no value for an operator that compares with nothing', () => {
    expect(withColumnCondition(undefined, 'id', { operator: 'isNull', value: 'ignored' })).toEqual({
      conditions: [{ column: 'id', operator: 'isNull' }],
    });
  });

  it('sends an empty value rather than none when the operator wants one', () => {
    expect(withColumnCondition(undefined, 'id', { operator: 'eq' })).toEqual({
      conditions: [{ column: 'id', operator: 'eq', value: '' }],
    });
  });

  it('removes only the column’s condition when none is given', () => {
    expect(withColumnCondition(base, 'name', undefined)).toEqual({
      conditions: [{ column: 'age', operator: 'gt', value: '3' }],
      where: 'active',
    });
  });

  it('returns null when nothing is left, which removes the filter', () => {
    expect(
      withColumnCondition({ conditions: [{ column: 'a', operator: 'isNull' }] }, 'a', undefined),
    ).toBeNull();
    expect(withColumnCondition(undefined, 'a', undefined)).toBeNull();
  });

  it('treats a blank WHERE as none', () => {
    expect(
      withColumnCondition(
        { conditions: [{ column: 'a', operator: 'isNull' }], where: '  ' },
        'a',
        undefined,
      ),
    ).toBeNull();
  });

  it('never grows past the number of conditions the host accepts', () => {
    const many: TableFilter = {
      conditions: Array.from({ length: 20 }, (_, index) => ({
        column: `c${index}`,
        operator: 'isNull' as const,
      })),
    };
    expect(withColumnCondition(many, 'extra', { operator: 'isNull' })?.conditions).toHaveLength(20);
  });
});

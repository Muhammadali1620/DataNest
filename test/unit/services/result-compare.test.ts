import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import {
  commonColumns,
  compareResults,
  comparisonSummary,
  MAX_DIFFERING_ROWS,
  type ComparedResult,
} from '../../../src/services/result-compare';
import type { CellValue } from '../../../src/shared/cell-value';

function result(columns: string[], rows: CellValue[][], title = 'q'): ComparedResult {
  return { title, columns, rows };
}

describe('commonColumns', () => {
  it('matches names without regard to case, in the order of the first', () => {
    expect(commonColumns(['ID', 'Name', 'x'], ['name', 'id', 'y'])).toEqual([
      { name: 'ID', left: 0, right: 1 },
      { name: 'Name', left: 1, right: 0 },
    ]);
  });

  it('takes the first of a repeated name', () => {
    expect(commonColumns(['id', 'id'], ['a', 'id', 'id'])).toEqual([
      { name: 'id', left: 0, right: 1 },
    ]);
  });

  it('is empty when nothing is shared', () => {
    expect(commonColumns(['a'], ['b'])).toEqual([]);
  });
});

describe('compareResults by key', () => {
  const left = result(
    ['id', 'name', 'qty'],
    [
      [1, 'apple', 10],
      [2, 'pear', 5],
      [3, 'plum', 7],
    ],
  );
  const right = result(
    ['id', 'name', 'qty'],
    [
      [3, 'plum', 7],
      [1, 'apple', 11],
      [4, 'fig', 1],
    ],
  );

  it('counts rows the same, different, and in one result only', () => {
    const comparison = compareResults(left, right, ['id']);
    expect(comparison).toMatchObject({ same: 1, different: 1, onlyLeft: 1, onlyRight: 1 });
    expect(comparison.differing).toEqual([{ key: '1', columns: ['qty'] }]);
  });

  it('lists the rows in matching order whatever order the results came in', () => {
    const comparison = compareResults(left, right, ['id']);
    expect(comparison.leftText).toBe('id\tname\tqty\n1\tapple\t10\n2\tpear\t5\n3\tplum\t7');
    expect(comparison.rightText).toBe('id\tname\tqty\n1\tapple\t11\n3\tplum\t7\n4\tfig\t1');
  });

  it('sorts numeric keys as numbers', () => {
    const comparison = compareResults(
      result(['id'], [[10], [9], [100]]),
      result(['id'], [[100], [10], [9]]),
      ['id'],
    );
    expect(comparison.leftText).toBe('id\n9\n10\n100');
    expect(comparison.rightText).toBe(comparison.leftText);
    expect(comparison.same).toBe(3);
  });

  it('treats 10.50 and 10.5, and an int and a decimal of one value, as equal', () => {
    const comparison = compareResults(
      result(['id', 'v'], [[1, { kind: 'decimal', text: '10.50' }]]),
      result(['id', 'v'], [[1, { kind: 'decimal', text: '10.5' }]]),
      ['id'],
    );
    expect(comparison).toMatchObject({ same: 1, different: 0 });
  });

  it('keeps a difference in case and NULL against an empty string', () => {
    const comparison = compareResults(
      result(['id', 'a', 'b'], [[1, 'x', null]]),
      result(['id', 'a', 'b'], [[1, 'X', '']]),
      ['id'],
    );
    expect(comparison.differing).toEqual([{ key: '1', columns: ['a', 'b'] }]);
  });

  it('matches several key columns together', () => {
    const comparison = compareResults(
      result(
        ['a', 'b', 'v'],
        [
          [1, 'x', 1],
          [1, 'y', 2],
        ],
      ),
      result(
        ['a', 'b', 'v'],
        [
          [1, 'y', 2],
          [1, 'x', 9],
        ],
      ),
      ['a', 'b'],
    );
    expect(comparison).toMatchObject({ same: 1, different: 1, onlyLeft: 0, onlyRight: 0 });
    expect(comparison.differing[0]?.key).toBe('1, x');
  });

  it('counts a key that repeats: two on each side match, a third is extra', () => {
    const comparison = compareResults(
      result(
        ['id', 'v'],
        [
          [1, 'a'],
          [1, 'a'],
          [1, 'a'],
        ],
      ),
      result(
        ['id', 'v'],
        [
          [1, 'a'],
          [1, 'a'],
        ],
      ),
      ['id'],
    );
    expect(comparison).toMatchObject({ same: 2, onlyLeft: 1, onlyRight: 0 });
  });

  it('compares only the columns both have and names the others', () => {
    const comparison = compareResults(
      result(['id', 'only_left', 'v'], [[1, 'l', 1]]),
      result(['ID', 'v', 'only_right'], [[1, 1, 'r']]),
      ['id'],
    );
    expect(comparison.columns).toEqual(['id', 'v']);
    expect(comparison.onlyLeftColumns).toEqual(['only_left']);
    expect(comparison.onlyRightColumns).toEqual(['only_right']);
    expect(comparison.same).toBe(1);
  });

  it('writes tabs, line breaks and backslashes inside values out, so a row is one line', () => {
    const comparison = compareResults(
      result(['id', 'v'], [[1, 'a\tb\nc\\d']]),
      result(['id', 'v'], [[1, 'a\tb\nc\\d']]),
      ['id'],
    );
    expect(comparison.leftText.split('\n')).toEqual(['id\tv', '1\ta\\tb\\nc\\\\d']);
  });

  it('shows NULL for null', () => {
    const comparison = compareResults(result(['id', 'v'], [[1, null]]), result(['id', 'v'], []), [
      'id',
    ]);
    expect(comparison.leftText).toBe('id\tv\n1\tNULL');
    expect(comparison.rightText).toBe('id\tv');
  });

  it('names no more than the limit of differing rows but counts them all', () => {
    const rows = Array.from({ length: MAX_DIFFERING_ROWS + 5 }, (_, index) => [index, 'a']);
    const other = rows.map(([id]) => [id as CellValue, 'b']);
    const comparison = compareResults(result(['id', 'v'], rows), result(['id', 'v'], other), [
      'id',
    ]);
    expect(comparison.different).toBe(MAX_DIFFERING_ROWS + 5);
    expect(comparison.differing).toHaveLength(MAX_DIFFERING_ROWS);
  });

  it('compares two empty results as the same', () => {
    const comparison = compareResults(result(['id'], []), result(['id'], []), ['id']);
    expect(comparison).toMatchObject({ same: 0, different: 0, onlyLeft: 0, onlyRight: 0 });
    expect(comparisonSummary(comparison)).toBe('The results are the same: 0 rows');
  });
});

describe('compareResults without a key', () => {
  it('compares whole rows, whatever their order', () => {
    const comparison = compareResults(
      result(
        ['a', 'b'],
        [
          [1, 'x'],
          [2, 'y'],
          [3, 'z'],
        ],
      ),
      result(
        ['a', 'b'],
        [
          [3, 'z'],
          [1, 'x'],
          [4, 'w'],
        ],
      ),
    );
    expect(comparison).toMatchObject({ same: 2, different: 0, onlyLeft: 1, onlyRight: 1 });
    expect(comparison.key).toEqual([]);
  });

  it('counts repeated rows', () => {
    const comparison = compareResults(
      result(['a'], [[1], [1], [2]]),
      result(['a'], [[1], [2], [2]]),
    );
    expect(comparison).toMatchObject({ same: 2, onlyLeft: 1, onlyRight: 1 });
  });

  it('matches rows when the columns come in another order', () => {
    const comparison = compareResults(
      result(['a', 'b'], [[1, 'x']]),
      result(['b', 'a'], [['x', 1]]),
    );
    expect(comparison.same).toBe(1);
  });
});

describe('compareResults errors', () => {
  it('refuses results with no column in common', () => {
    expect(() => compareResults(result(['a'], []), result(['b'], []))).toThrow(DbError);
  });

  it('refuses a key column one of the results lacks, naming it', () => {
    expect(() => compareResults(result(['id', 'a'], []), result(['a'], []), ['id'])).toThrow('id');
  });
});

describe('comparisonSummary', () => {
  it('gives the four counts when the results differ', () => {
    const comparison = compareResults(result(['id'], [[1], [2]]), result(['id'], [[2], [3]]), [
      'id',
    ]);
    expect(comparisonSummary(comparison)).toBe(
      '1 rows are the same, 0 differ, 1 only in the first result, 1 only in the second',
    );
  });
});

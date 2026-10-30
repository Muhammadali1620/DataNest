import { describe, expect, it } from 'vitest';
import { rowCounts, shownColumns } from '../../../../../webview/src/apps/data-compare/rows-view';

describe('shownColumns', () => {
  const rows = [
    {
      cells: ['1', 'a', 'b', 'c'],
      target: ['1', 'a', 'x', 'c'],
      differs: [false, false, true, false],
    },
    {
      cells: ['2', 'a', 'b', 'c'],
      target: ['2', 'z', 'b', 'c'],
      differs: [false, true, false, false],
    },
  ];

  it('shows the key and the columns that differ somewhere', () => {
    expect(shownColumns(rows, 1, 4, true)).toEqual([0, 1, 2]);
  });

  it('shows every column when asked', () => {
    expect(shownColumns(rows, 1, 4, false)).toEqual([0, 1, 2, 3]);
    expect(shownColumns([], 2, 3, true)).toEqual([0, 1]);
  });
});

describe('rowCounts', () => {
  it('gives the kept and the total rows of a kind', () => {
    const result = {
      same: 0,
      different: 20_000,
      onlySource: 1,
      onlyTarget: 0,
      kept: { different: 10_000, onlySource: 1, onlyTarget: 0 },
      durationMs: 1,
    };
    expect(rowCounts(result, 'different')).toEqual({ kept: 10_000, total: 20_000 });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildChart,
  type ChartConfig,
  type ColumnKind,
  columnKinds,
  MAX_SERIES,
  numberOf,
  POINT_LIMITS,
  suggestChart,
} from '../../../../src/services/charts/chart-data';
import type { CellValue } from '../../../../src/shared/cell-value';

const columns = (...names: string[]) => names.map((name) => ({ name }));

describe('numberOf', () => {
  it('reads numbers, exact numbers and numeric text', () => {
    expect(numberOf(12.5)).toBe(12.5);
    expect(numberOf({ kind: 'decimal', text: '10.50' })).toBe(10.5);
    expect(numberOf({ kind: 'bigint', text: '9007199254740993' })).toBe(9007199254740992);
    expect(numberOf(' 7 ')).toBe(7);
  });

  it('gives null for what is not a number', () => {
    for (const value of [
      null,
      'abc',
      '',
      true,
      Number.NaN,
      { kind: 'json', text: '1' },
    ] as CellValue[]) {
      expect(numberOf(value)).toBeNull();
    }
  });
});

describe('columnKinds', () => {
  it('trusts the declared type of times and the values otherwise', () => {
    const kinds = columnKinds(
      [
        { name: 'day', dataType: 'DATE' },
        { name: 'n', dataType: 'INT' },
        { name: 'price' },
        { name: 'name' },
        { name: 'at' },
        { name: 'iso' },
        { name: 'code', dataType: 'VARCHAR' },
        { name: 'flag' },
        { name: 'empty', dataType: 'numeric' },
        { name: 'nothing' },
      ],
      [
        [
          '2026-01-01',
          1,
          { kind: 'decimal', text: '1.5' },
          'a',
          { kind: 'datetime', text: '2026-01-01 10:00:00' },
          '2026-01-01T10:00:00Z',
          '007',
          true,
          null,
          null,
        ],
        [
          '2026-01-02',
          2,
          3,
          'b',
          { kind: 'datetime', text: '2026-01-02 10:00:00' },
          '2026-01-02',
          '008',
          false,
          null,
          null,
        ],
      ],
    );
    expect(kinds).toEqual([
      'time',
      'number',
      'number',
      'text',
      'time',
      'time',
      'text',
      'text',
      'number',
      'text',
    ]);
  });

  it('counts numbers typed as numbers even when the driver sends text', () => {
    expect(
      columnKinds([{ name: 'total', dataType: 'numeric' }], [['10.5'], [null], ['3']]),
    ).toEqual(['number']);
  });
});

describe('suggestChart', () => {
  it('draws numbers over time as lines', () => {
    expect(suggestChart(['time', 'number', 'text', 'number'], 100)).toEqual({
      type: 'line',
      x: 0,
      ys: [1, 3],
      aggregate: 'none',
    });
  });

  it('draws one value of a few labels as a pie, and more as bars', () => {
    expect(suggestChart(['text', 'number'], 5)).toEqual({
      type: 'pie',
      x: 0,
      ys: [1],
      aggregate: 'none',
    });
    expect(suggestChart(['text', 'number'], 50).type).toBe('bar');
    expect(suggestChart(['text', 'number', 'number'], 5).type).toBe('bar');
  });

  it('counts rows when there is nothing to add up, and takes the first column of numbers', () => {
    expect(suggestChart(['text', 'text'], 10)).toEqual({
      type: 'bar',
      x: 0,
      ys: [],
      aggregate: 'count',
    });
    expect(suggestChart(['number', 'number'], 10)).toEqual({
      type: 'line',
      x: 0,
      ys: [1],
      aggregate: 'none',
    });
  });

  it('draws at most the series a chart can tell apart', () => {
    const kinds: ColumnKind[] = ['text', ...Array.from({ length: 12 }, () => 'number' as const)];
    expect(suggestChart(kinds, 100).ys).toHaveLength(MAX_SERIES);
  });
});

describe('buildChart', () => {
  const line = (config: Partial<ChartConfig> = {}): ChartConfig => ({
    type: 'line',
    x: 0,
    ys: [1],
    aggregate: 'none',
    ...config,
  });

  it('draws a point per row, numbers kept, other values left out and counted', () => {
    const data = buildChart(
      columns('label', 'value'),
      [
        ['a', 1],
        ['b', 'x'],
        ['c', null],
        ['d', { kind: 'decimal', text: '2.5' }],
      ],
      ['text', 'number'],
      line({ type: 'bar' }),
    );
    expect(data).toEqual({
      labels: ['a', 'b', 'c', 'd'],
      series: [{ name: 'value', values: [1, null, null, 2.5] }],
      labelKind: 'text',
      points: 4,
      skipped: 1,
    });
  });

  it('orders times and numbers along the axis, unreadable ones last', () => {
    const data = buildChart(
      columns('day', 'n'),
      [
        ['2026-03-01 00:00:00+00', 3],
        [null, 9],
        ['2026-01-01 00:00:00+00', 1],
        ['2026-02-01 00:00:00+00', 2],
      ],
      ['time', 'number'],
      line(),
    );
    expect(data.labels).toEqual([
      '2026-01-01 00:00:00+00',
      '2026-02-01 00:00:00+00',
      '2026-03-01 00:00:00+00',
      'NULL',
    ]);
    expect(data.series[0]?.values).toEqual([1, 2, 3, 9]);
    const numbers = buildChart(
      columns('x', 'y'),
      [
        [10, 1],
        [2, 2],
        [33, 3],
      ],
      ['number', 'number'],
      line(),
    );
    const days = buildChart(
      columns('day', 'n'),
      [
        ['2026-01-11', 3],
        ['2026-01-02', 2],
        ['2026-01-01T08:30:00.5+05', 1],
      ],
      ['time', 'number'],
      line(),
    );
    expect(days.labels).toEqual(['2026-01-01T08:30:00.5+05', '2026-01-02', '2026-01-11']);
    expect(numbers.labels).toEqual(['2', '10', '33']);
  });

  it('groups rows of one label by sum, average, count, minimum and maximum', () => {
    const rows: CellValue[][] = [
      ['a', 1, 10],
      ['b', 5, null],
      ['a', 3, 30],
    ];
    const kinds = ['text', 'number', 'number'] as const;
    const of = (aggregate: ChartConfig['aggregate']) =>
      buildChart(columns('k', 'v', 'w'), rows, kinds, {
        type: 'bar',
        x: 0,
        ys: [1, 2],
        aggregate,
      }).series.map((series) => series.values);
    expect(of('sum')).toEqual([
      [4, 5],
      [40, null],
    ]);
    expect(of('avg')).toEqual([
      [2, 5],
      [20, null],
    ]);
    expect(of('min')).toEqual([
      [1, 5],
      [10, null],
    ]);
    expect(of('max')).toEqual([
      [3, 5],
      [30, null],
    ]);
    const count = buildChart(columns('k', 'v'), rows, kinds, {
      type: 'bar',
      x: 0,
      ys: [],
      aggregate: 'count',
    });
    expect(count.labels).toEqual(['a', 'b']);
    expect(count.series).toEqual([{ name: 'count', values: [2, 1] }]);
  });

  it('keeps big groups off the stack', () => {
    const rows = Array.from({ length: 150_000 }, (_row, index): CellValue[] => ['all', index]);
    const data = buildChart(columns('k', 'v'), rows, ['text', 'number'], {
      type: 'bar',
      x: 0,
      ys: [1],
      aggregate: 'max',
    });
    expect(data.series[0]?.values).toEqual([149_999]);
  });

  it('stops at the points a chart can show, saying how many there were', () => {
    const rows = Array.from({ length: 2500 }, (_row, index): CellValue[] => [index, index]);
    const lines = buildChart(columns('x', 'y'), rows, ['number', 'number'], line());
    expect(lines.labels).toHaveLength(POINT_LIMITS.line);
    expect(lines.series[0]?.values).toHaveLength(POINT_LIMITS.line);
    expect(lines.points).toBe(2500);
    const bars = buildChart(columns('x', 'y'), rows, ['text', 'number'], line({ type: 'bar' }));
    expect(bars.labels).toHaveLength(POINT_LIMITS.bar);
  });

  it('draws the biggest slices of a pie and folds the rest into the last one', () => {
    const rows = Array.from({ length: 20 }, (_row, index): CellValue[] => [`s${index}`, index]);
    const data = buildChart(columns('slice', 'n'), rows, ['text', 'number'], {
      type: 'pie',
      x: 0,
      ys: [1, 0],
      aggregate: 'none',
    });
    expect(data.labels).toHaveLength(POINT_LIMITS.pie);
    expect(data.labels.slice(0, 2)).toEqual(['s19', 's18']);
    expect(data.labels.at(-1)).toBe('');
    // Eleven slices s19…s9 stay, s8…s1 are folded; s0 is nothing and is not drawn at all.
    expect(data.folded).toBe(8);
    expect(data.series[0]?.values.at(-1)).toBe(36);
    expect(data.series).toHaveLength(1);
  });

  it('leaves out pie slices of nothing or less', () => {
    const data = buildChart(
      columns('k', 'v'),
      [
        ['a', 3],
        ['b', 0],
        ['c', -2],
        ['d', null],
        ['e', 1],
      ],
      ['text', 'number'],
      { type: 'pie', x: 0, ys: [1], aggregate: 'none' },
    );
    expect(data.labels).toEqual(['a', 'e']);
    expect(data.folded).toBeUndefined();
  });

  it('names unnamed columns and draws at most eight series', () => {
    const many = Array.from({ length: 10 }, (_value, index) => index + 1);
    const data = buildChart(
      [{ name: 'k' }],
      [['a', ...many]],
      ['text', ...many.map(() => 'number' as const)],
      { type: 'bar', x: 0, ys: many, aggregate: 'none' },
    );
    expect(data.series).toHaveLength(MAX_SERIES);
    expect(data.series[0]?.name).toBe('#2');
  });
});

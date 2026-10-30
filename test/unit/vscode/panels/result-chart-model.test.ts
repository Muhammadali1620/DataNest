import { describe, expect, it } from 'vitest';
import type { CellValue } from '../../../../src/shared/cell-value';
import { MAX_CHART_ROWS, ResultChartModel } from '../../../../src/vscode/panels/result-chart-model';

const COLUMNS = [
  { name: 'region' },
  { name: 'orders', dataType: 'int' },
  { name: 'total', dataType: 'numeric' },
];
const ROWS: CellValue[][] = [
  ['north', 10, { kind: 'decimal', text: '100.50' }],
  ['south', 5, { kind: 'decimal', text: '40' }],
  ['east', 7, null],
];

function model(rows: CellValue[][] = ROWS, truncated = false) {
  return new ResultChartModel({
    statement: 'SELECT region, orders, total\nFROM   sales',
    columns: COLUMNS,
    rows,
    truncated,
  });
}

describe('ResultChartModel', () => {
  it('opens on a first chart of the result', () => {
    const state = model().state();
    expect(state).toMatchObject({
      title: 'SELECT region, orders, total FROM sales',
      columns: [
        { name: 'region', kind: 'text' },
        { name: 'orders', kind: 'number' },
        { name: 'total', kind: 'number' },
      ],
      rows: 3,
      truncated: false,
      config: { type: 'bar', x: 0, ys: [1, 2], aggregate: 'none' },
    });
    expect(state.data.labels).toEqual(['north', 'south', 'east']);
    expect(state.data.series.map((series) => series.values)).toEqual([
      [10, 5, 7],
      [100.5, 40, null],
    ]);
  });

  it('draws another chart and keeps it for the next load', () => {
    const chart = model();
    const data = chart.configure({ type: 'pie', x: 0, ys: [2, 1, 2], aggregate: 'sum' });
    expect(data.series).toEqual([{ name: 'total', values: [100.5, 40] }]);
    expect(chart.state().config).toEqual({ type: 'pie', x: 0, ys: [2], aggregate: 'sum' });
    expect(
      chart.configure({ type: 'bar', x: 0, ys: [1, 1], aggregate: 'none' }).series,
    ).toHaveLength(1);
  });

  it('counts rows without a column of values', () => {
    expect(model().configure({ type: 'bar', x: 0, ys: [], aggregate: 'count' }).series).toEqual([
      { name: 'count', values: [1, 1, 1] },
    ]);
  });

  it('refuses columns the result does not have, and values from nowhere', () => {
    const chart = model();
    expect(() => chart.configure({ type: 'bar', x: 3, ys: [1], aggregate: 'none' })).toThrow(
      'does not have',
    );
    expect(() => chart.configure({ type: 'bar', x: 0, ys: [9], aggregate: 'none' })).toThrow(
      'does not have',
    );
    expect(() => chart.configure({ type: 'line', x: 0, ys: [], aggregate: 'sum' })).toThrow(
      'count the rows',
    );
  });

  it('copies at most so many rows and says the chart may miss some', () => {
    const many = Array.from({ length: MAX_CHART_ROWS + 5 }, (_row, index): CellValue[] => [
      `r${index}`,
      index,
      1,
    ]);
    const state = model(many).state();
    expect(state.rows).toBe(MAX_CHART_ROWS);
    expect(state.truncated).toBe(true);
    expect(model(ROWS, true).state().truncated).toBe(true);
  });

  it('cuts very long labels and series names', () => {
    const chart = new ResultChartModel({
      statement: 'SELECT',
      columns: [{ name: 'k' }, { name: 'v'.repeat(300) }],
      rows: [['x'.repeat(500), 1]],
      truncated: false,
    });
    const { data } = chart.state();
    expect(data.labels[0]).toHaveLength(201);
    expect(data.series[0]?.name.endsWith('…')).toBe(true);
  });

  it('refuses a result without columns', () => {
    expect(
      () =>
        new ResultChartModel({
          statement: 'UPDATE t SET x = 1',
          columns: [],
          rows: [],
          truncated: false,
        }),
    ).toThrow('no columns');
  });

  it('is not changed by later changes to the result', () => {
    const rows: CellValue[][] = [['a', 1, 1]];
    const chart = model(rows);
    rows.push(['b', 2, 2]);
    expect(chart.state().data.labels).toEqual(['a']);
  });
});

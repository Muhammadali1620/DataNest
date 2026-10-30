// What the chart page of a query result (V8.7) shows, free of `vscode`: a copy of the
// result's rows taken when the chart opens, the chart's settings and its numbers.

import { DbError } from '../../core/errors';
import type { ResultColumn } from '../../drivers/driver';
import {
  buildChart,
  type ChartConfig,
  type ChartData,
  type ColumnKind,
  columnKinds,
  MAX_SERIES,
  suggestChart,
} from '../../services/charts/chart-data';
import type { CellValue } from '../../shared/cell-value';
import { tabTitle } from '../../shared/protocols/result-grid';
import type { ResultChartState } from '../../shared/protocols/result-chart';

export interface ResultChartModelDeps {
  readonly statement: string;
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly (readonly CellValue[])[];
  readonly truncated: boolean;
}

/** Most rows a chart copies from a result; more is cut, and said so. */
export const MAX_CHART_ROWS = 100_000;

export class ResultChartModel {
  private readonly rows: readonly (readonly CellValue[])[];
  private readonly kinds: ColumnKind[];
  private readonly truncated: boolean;
  private config: ChartConfig;
  private data: ChartData;

  constructor(private readonly deps: ResultChartModelDeps) {
    if (deps.columns.length === 0) {
      throw new DbError('unsupported', 'The result has no columns to draw');
    }
    this.rows = deps.rows.slice(0, MAX_CHART_ROWS);
    this.truncated = deps.truncated || deps.rows.length > MAX_CHART_ROWS;
    this.kinds = columnKinds(deps.columns, this.rows);
    this.config = suggestChart(this.kinds, this.rows.length);
    this.data = this.build(this.config);
  }

  state(): ResultChartState {
    return {
      title: tabTitle(this.deps.statement, 60),
      columns: this.deps.columns.map((column, index) => ({
        name: column.name,
        kind: this.kinds[index] ?? 'text',
      })),
      rows: this.rows.length,
      truncated: this.truncated,
      config: { ...this.config, ys: [...this.config.ys] },
      data: this.view(),
    };
  }

  /** Draws the chart another way and keeps the settings for the next time the page loads. */
  configure(config: ChartConfig): ResultChartState['data'] {
    const width = this.deps.columns.length;
    const inside = (index: number): boolean => index >= 0 && index < width;
    if (!inside(config.x) || !config.ys.every(inside)) {
      throw new DbError('syntax', 'The chart names a column the result does not have');
    }
    if (config.ys.length === 0 && config.aggregate !== 'count') {
      throw new DbError('syntax', 'Pick a column of values, or count the rows');
    }
    this.config = {
      type: config.type,
      x: config.x,
      ys: [...new Set(config.ys)].slice(0, config.type === 'pie' ? 1 : MAX_SERIES),
      aggregate: config.aggregate,
    };
    this.data = this.build(this.config);
    return this.view();
  }

  private build(config: ChartConfig): ChartData {
    return buildChart(this.deps.columns, this.rows, this.kinds, config);
  }

  private view(): ResultChartState['data'] {
    const data = this.data;
    return {
      labels: data.labels.map(short),
      series: data.series.map((series) => ({
        name: short(series.name),
        values: [...series.values],
      })),
      labelKind: data.labelKind,
      points: data.points,
      skipped: data.skipped,
      ...(data.folded === undefined ? {} : { folded: data.folded }),
    };
  }
}

/** Labels are for reading on a chart: a long text is cut. */
const LABEL = 200;

function short(text: string): string {
  return text.length > LABEL ? `${text.slice(0, LABEL)}…` : text;
}

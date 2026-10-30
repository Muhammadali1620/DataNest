// The chart of a query result (V8.7): the host keeps a copy of the result's rows and the
// chart's settings, and answers with labels and series; the page draws them.

import { defineProtocol } from '../rpc';
import {
  array,
  boolean,
  type Infer,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
} from '../schema';

const NAME = 1000;
/** A PNG of a big chart as base64, or its SVG. */
const MAX_PICTURE = 40_000_000;

export const CHART_TYPES = ['line', 'bar', 'pie'] as const;
export const CHART_AGGREGATES = ['none', 'sum', 'avg', 'count', 'min', 'max'] as const;

const configSchema = object({
  type: literal(...CHART_TYPES),
  x: number({ integer: true, min: 0, max: 10_000 }),
  ys: array(number({ integer: true, min: 0, max: 10_000 }), { maxLength: 8 }),
  aggregate: literal(...CHART_AGGREGATES),
});

const dataSchema = object({
  labels: array(string({ maxLength: NAME }), { maxLength: 2000 }),
  series: array(
    object({
      name: string({ maxLength: NAME }),
      values: array(nullable(number()), { maxLength: 2000 }),
    }),
    { maxLength: 8 },
  ),
  labelKind: literal('number', 'time', 'text'),
  points: number({ integer: true, min: 0 }),
  skipped: number({ integer: true, min: 0 }),
  folded: optional(number({ integer: true, min: 0 })),
});

const stateSchema = object({
  /** The first words of the statement. */
  title: string({ maxLength: NAME }),
  columns: array(
    object({ name: string({ maxLength: NAME }), kind: literal('number', 'time', 'text') }),
    { maxLength: 10_000 },
  ),
  /** Rows the chart is drawn from. */
  rows: number({ integer: true, min: 0 }),
  /** The result itself was cut by the row limit, so the chart may miss rows too. */
  truncated: boolean(),
  config: configSchema,
  data: dataSchema,
});

export const resultChartProtocol = defineProtocol({
  host: {
    requests: {
      /** Draws the chart another way; the host keeps the settings. */
      configure: { params: object({ config: configSchema }), result: object({ data: dataSchema }) },
      /** Saves a picture of the chart to a file the user picks. */
      save: {
        params: object({
          format: literal('svg', 'png'),
          /** SVG text, or a PNG as base64. */
          data: string({ maxLength: MAX_PICTURE }),
        }),
        result: object({ saved: boolean() }),
      },
    },
    events: {
      ready: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: stateSchema,
    },
  },
});

export type ResultChartProtocol = typeof resultChartProtocol;
export type ResultChartState = Infer<typeof stateSchema>;
export type ChartConfigData = Infer<typeof configSchema>;
export type ChartDataView = Infer<typeof dataSchema>;

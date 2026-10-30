// The numbers of a chart of a query result (V8.7): which columns are numbers, times or
// text, a first guess at a chart, and the labels and series of the chart asked for —
// one point per row or rows grouped by the label, with limits a picture can show.

import type { ResultColumn } from '../../drivers/driver';
import type { CellValue } from '../../shared/cell-value';
import { isTaggedValue } from '../../shared/cell-value';
import { cellText } from '../../shared/cell-text';

export type ColumnKind = 'number' | 'time' | 'text';
export type ChartType = 'line' | 'bar' | 'pie';
export type ChartAggregate = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max';

export interface ChartConfig {
  readonly type: ChartType;
  /** The column of the labels (the x axis, the slices). */
  readonly x: number;
  /** The columns of the values, one series each; one for a pie. */
  readonly ys: readonly number[];
  /** Rows with the same label become one point. */
  readonly aggregate: ChartAggregate;
}

export interface ChartSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
}

export interface ChartData {
  readonly labels: readonly string[];
  readonly series: readonly ChartSeries[];
  /** What the labels are, so a line over times or numbers is drawn in order. */
  readonly labelKind: ColumnKind;
  /** Points there were before the limit. */
  readonly points: number;
  /** Values that were not numbers and are left out. */
  readonly skipped: number;
  /** For a pie: the slices folded into the last one, `Other`. */
  readonly folded?: number;
}

/** Most series one chart draws. */
export const MAX_SERIES = 8;
/** Most points of a line, bars of a bar chart, slices of a pie (with `Other`). */
export const POINT_LIMITS: Readonly<Record<ChartType, number>> = { line: 2000, bar: 200, pie: 12 };

/** Rows looked at to tell a column's kind. */
const SAMPLE = 200;
const TIME_TYPES = /date|time/iu;
const NUMBER_TYPES = /int|dec|num|float|double|real|money|serial/iu;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/u;

/** A value as a number, or null when it is not one. */
export function numberOf(value: CellValue): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  let text: string | undefined;
  if (typeof value === 'string') {
    text = value;
  } else if (isTaggedValue(value) && (value.kind === 'bigint' || value.kind === 'decimal')) {
    text = value.text;
  }
  if (text === undefined || text.trim() === '') {
    return null;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** Numbers, times or text, from the declared type and then the values themselves. */
export function columnKinds(
  columns: readonly ResultColumn[],
  rows: readonly (readonly CellValue[])[],
): ColumnKind[] {
  return columns.map((column, index) => {
    const type = column.dataType ?? '';
    if (TIME_TYPES.test(type)) {
      return 'time';
    }
    const values = rows
      .slice(0, SAMPLE)
      .map((row) => row[index] ?? null)
      .filter((value) => value !== null);
    if (values.length === 0) {
      return NUMBER_TYPES.test(type) ? 'number' : 'text';
    }
    if (values.every((value) => isTaggedValue(value) && value.kind === 'datetime')) {
      return 'time';
    }
    if (values.every((value) => typeof value !== 'boolean' && numberOf(value) !== null)) {
      // A column of digits typed as text (a code, a phone) is still a label.
      return typeof values[0] === 'string' && !NUMBER_TYPES.test(type) ? 'text' : 'number';
    }
    if (values.every((value) => typeof value === 'string' && ISO_TIME.test(value))) {
      return 'time';
    }
    return 'text';
  });
}

/**
 * A first chart: labels from the first time column, else the first text column, else
 * the row's first column; values from the number columns. Over time, a line; few
 * labels and one value, a pie; otherwise bars.
 */
export function suggestChart(kinds: readonly ColumnKind[], rowCount: number): ChartConfig {
  const time = kinds.indexOf('time');
  const text = kinds.indexOf('text');
  const x = time >= 0 ? time : text >= 0 ? text : 0;
  const ys = kinds
    .map((kind, index) => (kind === 'number' && index !== x ? index : -1))
    .filter((index) => index >= 0)
    .slice(0, MAX_SERIES);
  if (ys.length === 0) {
    // Nothing to add up: count the rows of each label.
    return { type: 'bar', x, ys: [], aggregate: 'count' };
  }
  const type: ChartType =
    kinds[x] === 'time' || kinds[x] === 'number'
      ? 'line'
      : ys.length === 1 && rowCount <= POINT_LIMITS.pie
        ? 'pie'
        : 'bar';
  return { type, x, ys: type === 'pie' ? ys.slice(0, 1) : ys, aggregate: 'none' };
}

export function buildChart(
  columns: readonly ResultColumn[],
  rows: readonly (readonly CellValue[])[],
  kinds: readonly ColumnKind[],
  config: ChartConfig,
): ChartData {
  const labelKind = kinds[config.x] ?? 'text';
  const counting = config.aggregate === 'count';
  const ys = (config.type === 'pie' ? config.ys.slice(0, 1) : config.ys).slice(0, MAX_SERIES);
  const names = counting ? ['count'] : ys.map((index) => columns[index]?.name ?? `#${index + 1}`);
  let skipped = 0;
  const valuesOf = (row: readonly CellValue[]): (number | null)[] =>
    counting
      ? [1]
      : ys.map((index) => {
          const value = row[index] ?? null;
          const number = numberOf(value);
          if (number === null && value !== null) {
            skipped += 1;
          }
          return number;
        });

  let labels: string[] = [];
  let series: (number | null)[][] = names.map(() => []);
  let order: number[] = [];
  if (config.aggregate === 'none') {
    for (const row of rows) {
      labels.push(labelOf(row[config.x] ?? null));
      order.push(sortKey(row[config.x] ?? null, labelKind));
      valuesOf(row).forEach((value, index) => series[index]?.push(value));
    }
  } else {
    const groups = new Map<string, { key: number; values: (number | null)[][] }>();
    for (const row of rows) {
      const label = labelOf(row[config.x] ?? null);
      let group = groups.get(label);
      if (group === undefined) {
        group = { key: sortKey(row[config.x] ?? null, labelKind), values: names.map(() => []) };
        groups.set(label, group);
      }
      valuesOf(row).forEach((value, index) => group.values[index]?.push(value));
    }
    labels = [...groups.keys()];
    order = [...groups.values()].map((group) => group.key);
    series = names.map((_name, index) =>
      [...groups.values()].map((group) => aggregate(group.values[index] ?? [], config.aggregate)),
    );
  }

  // Times and numbers along an axis read left to right; categories keep the result's order.
  if (config.type !== 'pie' && labelKind !== 'text') {
    // Labels with no place (NULL, unreadable) go last, in the order they came.
    const indexes = labels
      .map((_label, index) => index)
      .sort((a, b) => {
        const left = order[a] ?? Number.NaN;
        const right = order[b] ?? Number.NaN;
        if (Number.isNaN(left) || Number.isNaN(right)) {
          return Number(Number.isNaN(left)) - Number(Number.isNaN(right)) || a - b;
        }
        return left - right || a - b;
      });
    labels = indexes.map((index) => labels[index] ?? '');
    series = series.map((values) => indexes.map((index) => values[index] ?? null));
  }

  const points = labels.length;
  if (config.type === 'pie') {
    return { ...pie(labels, series[0] ?? [], names[0] ?? ''), labelKind, points, skipped };
  }
  const limit = POINT_LIMITS[config.type];
  return {
    labels: labels.slice(0, limit),
    series: names.map((name, index) => ({ name, values: (series[index] ?? []).slice(0, limit) })),
    labelKind,
    points,
    skipped,
  };
}

/** The biggest slices, the rest folded into `Other` (its label left to the page). */
function pie(
  labels: readonly string[],
  values: readonly (number | null)[],
  name: string,
): Pick<ChartData, 'labels' | 'series' | 'folded'> {
  // A slice of nothing or less than nothing cannot be drawn.
  const slices = labels
    .map((label, index) => ({ label, value: values[index] ?? null }))
    .filter(
      (slice): slice is { label: string; value: number } => slice.value !== null && slice.value > 0,
    )
    .sort((a, b) => b.value - a.value);
  const limit = POINT_LIMITS.pie;
  if (slices.length <= limit) {
    return {
      labels: slices.map((slice) => slice.label),
      series: [{ name, values: slices.map((slice) => slice.value) }],
    };
  }
  const kept = slices.slice(0, limit - 1);
  const rest = slices.slice(limit - 1);
  return {
    labels: [...kept.map((slice) => slice.label), ''],
    series: [
      {
        name,
        values: [
          ...kept.map((slice) => slice.value),
          rest.reduce((sum, slice) => sum + slice.value, 0),
        ],
      },
    ],
    folded: rest.length,
  };
}

function aggregate(values: readonly (number | null)[], how: ChartAggregate): number | null {
  if (how === 'count') {
    return values.length;
  }
  const numbers = values.filter((value): value is number => value !== null);
  if (numbers.length === 0) {
    return null;
  }
  switch (how) {
    case 'sum':
    case 'none':
      return numbers.reduce((sum, value) => sum + value, 0);
    case 'avg':
      return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    // Not Math.min(...numbers): a hundred thousand arguments overflow the stack.
    case 'min':
      return numbers.reduce((least, value) => (value < least ? value : least));
    case 'max':
      return numbers.reduce((most, value) => (value > most ? value : most));
  }
}

function labelOf(value: CellValue): string {
  return value === null ? 'NULL' : cellText(value);
}

/** Where a label goes along an ordered axis; NaN keeps it where it is. */
function sortKey(value: CellValue, kind: ColumnKind): number {
  if (value === null) {
    return Number.NaN;
  }
  if (kind === 'number') {
    return numberOf(value) ?? Number.NaN;
  }
  if (kind === 'time') {
    // `2026-10-30 08:00:00+00` as Date.parse reads it: a T, and minutes in the zone.
    const text = cellText(value)
      .replace(' ', 'T')
      .replace(/(:\d{2}(?:\.\d+)?[+-]\d{2})$/u, '$1:00');
    return Date.parse(text);
  }
  return Number.NaN;
}

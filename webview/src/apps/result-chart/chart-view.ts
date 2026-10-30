// The geometry of a result chart (V8.7): one scene of lines, rectangles, arcs and texts
// that the page draws and the saved SVG repeats, so both always look the same.

import type { ChartDataView } from '../../../../src/shared/protocols/result-chart';

export type ChartKind = 'line' | 'bar' | 'pie';

/** A role in the picture; the page and the SVG give each role its colour. */
export type Ink = 'axis' | 'grid' | 'text' | 'muted' | 'background';

export type Shape =
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly ink: Ink;
    }
  | { readonly kind: 'polyline'; readonly points: string; readonly series: number }
  | {
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly series: number;
    }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly series: number;
    }
  | { readonly kind: 'arc'; readonly d: string; readonly series: number }
  | {
      readonly kind: 'text';
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly anchor: 'start' | 'middle' | 'end';
      readonly ink: Ink;
    };

/** Where the pointer finds a point: its label and, for bars and slices, its series. */
export interface Hit {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly index: number;
  readonly series?: number;
}

export interface Scene {
  readonly width: number;
  readonly height: number;
  readonly shapes: readonly Shape[];
  readonly hits: readonly Hit[];
  /** Where the plot is, for the line chart's guide. */
  readonly plot: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** For a line chart: the x of each label, so the pointer finds the nearest. */
  readonly xs: readonly number[];
}

export interface SceneOptions {
  readonly data: ChartDataView;
  readonly kind: ChartKind;
  readonly width: number;
  readonly height: number;
  /** What the folded slice of a pie is called. */
  readonly otherLabel: string;
  readonly locale?: string;
}

/** Colours of the series, from the editor's chart colours where the theme has them. */
export const SERIES_COLORS = 8;

const FONT_WIDTH = 6.6;
const LINE = 16;
const PAD = 12;

/** About 5 round steps from min to max: 0, 250, 500… */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0];
  }
  if (min === max) {
    const step = min === 0 ? 1 : Math.abs(min) / 2;
    return [min - step, min, min + step];
  }
  const raw = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((one) => one >= raw) ?? raw;
  const first = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let tick = first; tick <= max + step * 1e-9; tick += step) {
    ticks.push(Math.abs(tick) < step * 1e-9 ? 0 : Number(tick.toPrecision(12)));
  }
  if ((ticks.at(-1) ?? max) < max) {
    ticks.push(Number(((ticks.at(-1) ?? max) + step).toPrecision(12)));
  }
  return ticks;
}

/** `1.2K`, `3.4M`, `0.25`: numbers that fit beside an axis. */
export function formatNumber(value: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale, {
    notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 100 ? 1 : 3,
  }).format(value);
}

/** Shortens a label to about `width` pixels. */
export function fit(text: string, width: number): string {
  const chars = Math.max(1, Math.floor(width / FONT_WIDTH));
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
}

/**
 * Where each label sits along a line chart's axis: by value where every label is a
 * number or a time, so gaps show as gaps; evenly otherwise.
 */
export function axisPositions(
  labels: readonly string[],
  kind: ChartDataView['labelKind'],
): number[] {
  const values =
    kind === 'number'
      ? labels.map(Number)
      : kind === 'time'
        ? labels.map((label) =>
            Date.parse(label.replace(' ', 'T').replace(/(:\d{2}(?:\.\d+)?[+-]\d{2})$/u, '$1:00')),
          )
        : [];
  const usable = values.length > 0 && values.every((value) => Number.isFinite(value));
  if (!usable) {
    return labels.map((_label, index) => (labels.length <= 1 ? 0.5 : index / (labels.length - 1)));
  }
  const least = Math.min(...values);
  const most = Math.max(...values);
  return values.map((value) => (most === least ? 0.5 : (value - least) / (most - least)));
}

/** Labels far enough apart to be read: the first, then each one `gap` pixels on. */
export function spacedLabels(xs: readonly number[], gap: number): number[] {
  const shown: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  xs.forEach((x, index) => {
    if (x - last >= gap) {
      shown.push(index);
      last = x;
    }
  });
  return shown;
}

function legend(names: readonly string[], width: number): { shapes: Shape[]; height: number } {
  const shapes: Shape[] = [];
  let x = PAD;
  let y = PAD;
  names.forEach((name, series) => {
    const text = fit(name, 180);
    const itemWidth = 14 + text.length * FONT_WIDTH + 16;
    if (x + itemWidth > width - PAD && x > PAD) {
      x = PAD;
      y += LINE;
    }
    shapes.push({ kind: 'rect', x, y: y + 2, width: 10, height: 10, series });
    shapes.push({ kind: 'text', x: x + 14, y: y + 11, text, anchor: 'start', ink: 'text' });
    x += itemWidth;
  });
  return { shapes, height: names.length === 0 ? 0 : y + LINE - PAD + 6 };
}

export function chartScene(options: SceneOptions): Scene {
  return options.kind === 'pie' ? pieScene(options) : axisScene(options);
}

function axisScene({ data, kind, width, height, locale }: SceneOptions): Scene {
  const shapes: Shape[] = [];
  const hits: Hit[] = [];
  const names = data.series.map((series) => series.name);
  const key = legend(names, width);
  shapes.push(...key.shapes);
  const values = data.series.flatMap((series) =>
    series.values.filter((value): value is number => value !== null),
  );
  let least = values.length === 0 ? 0 : values.reduce((a, b) => (b < a ? b : a));
  let most = values.length === 0 ? 1 : values.reduce((a, b) => (b > a ? b : a));
  if (kind === 'bar') {
    // Bars grow from zero.
    least = Math.min(0, least);
    most = Math.max(0, most);
  }
  const ticks = niceTicks(least, most);
  const low = ticks[0] ?? least;
  const high = ticks.at(-1) ?? most;
  const tickTexts = ticks.map((tick) => formatNumber(tick, locale));
  const left = PAD + Math.max(...tickTexts.map((text) => text.length)) * FONT_WIDTH + 8;
  const top = PAD + key.height;
  const right = width - PAD;
  const bottom = height - PAD - LINE - 4;
  const plot = { left, top, right: Math.max(left + 10, right), bottom: Math.max(top + 10, bottom) };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const yOf = (value: number): number =>
    plot.bottom - (high === low ? 0.5 : (value - low) / (high - low)) * plotHeight;

  ticks.forEach((tick, index) => {
    const y = yOf(tick);
    shapes.push({
      kind: 'line',
      x1: plot.left,
      y1: y,
      x2: plot.right,
      y2: y,
      ink: tick === 0 ? 'axis' : 'grid',
    });
    shapes.push({
      kind: 'text',
      x: plot.left - 6,
      y: y + 4,
      text: tickTexts[index] ?? '',
      anchor: 'end',
      ink: 'muted',
    });
  });
  shapes.push({
    kind: 'line',
    x1: plot.left,
    y1: plot.top,
    x2: plot.left,
    y2: plot.bottom,
    ink: 'axis',
  });

  const count = data.labels.length;
  let xs: number[];
  if (kind === 'bar') {
    const band = plotWidth / Math.max(1, count);
    xs = data.labels.map((_label, index) => plot.left + band * (index + 0.5));
    const groups = Math.max(1, data.series.length);
    const barWidth = Math.max(1, (band * 0.8) / groups);
    const zero = yOf(Math.max(low, Math.min(high, 0)));
    data.series.forEach((series, seriesIndex) => {
      series.values.forEach((value, index) => {
        if (value === null) {
          return;
        }
        const x = plot.left + band * index + band * 0.1 + barWidth * seriesIndex;
        const y = yOf(value);
        const rect = {
          x,
          y: Math.min(y, zero),
          width: barWidth,
          height: Math.max(1, Math.abs(zero - y)),
        };
        shapes.push({ kind: 'rect', ...rect, series: seriesIndex });
        hits.push({ ...rect, index, series: seriesIndex });
      });
    });
  } else {
    xs = axisPositions(data.labels, data.labelKind).map((share) => plot.left + share * plotWidth);
    data.series.forEach((series, seriesIndex) => {
      // A missing value breaks the line rather than drawing it to zero.
      let run: string[] = [];
      const flush = (): void => {
        if (run.length > 1) {
          shapes.push({ kind: 'polyline', points: run.join(' '), series: seriesIndex });
        }
        run = [];
      };
      series.values.forEach((value, index) => {
        const x = xs[index] ?? plot.left;
        if (value === null) {
          flush();
          return;
        }
        const point = `${round(x)},${round(yOf(value))}`;
        run.push(point);
        if (count <= 60 || series.values.length === 1) {
          shapes.push({
            kind: 'circle',
            cx: round(x),
            cy: round(yOf(value)),
            r: 2.5,
            series: seriesIndex,
          });
        }
      });
      flush();
    });
    xs.forEach((x, index) => {
      const before = xs[index - 1] ?? plot.left;
      const after = xs[index + 1] ?? plot.right;
      const from = index === 0 ? plot.left : (before + x) / 2;
      const to = index === count - 1 ? plot.right : (x + after) / 2;
      hits.push({ x: from, y: plot.top, width: Math.max(1, to - from), height: plotHeight, index });
    });
  }

  const labelGap = Math.min(
    160,
    Math.max(48, ...data.labels.map((label) => Math.min(label.length, 18) * FONT_WIDTH + 12)),
  );
  for (const index of spacedLabels(xs, labelGap)) {
    const x = round(xs[index] ?? 0);
    const text = fit(data.labels[index] ?? '', labelGap - 8);
    const half = (text.length * FONT_WIDTH) / 2;
    // A label at an edge is pinned inside the picture rather than cut by it.
    const anchor = x - half < 0 ? 'start' : x + half > width ? 'end' : 'middle';
    shapes.push({ kind: 'text', x, y: plot.bottom + LINE, text, anchor, ink: 'muted' });
  }
  return { width, height, shapes, hits, plot, xs };
}

function pieScene({ data, width, height, otherLabel, locale }: SceneOptions): Scene {
  const shapes: Shape[] = [];
  const hits: Hit[] = [];
  const values = (data.series[0]?.values ?? []).map((value) => value ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const labels = data.labels.map((label, index) =>
    label === '' && index === data.labels.length - 1 && data.folded !== undefined
      ? otherLabel
      : label,
  );
  const names = labels.map((label, index) => {
    const share = total === 0 ? 0 : (values[index] ?? 0) / total;
    return `${label} — ${formatNumber(values[index] ?? 0, locale)} (${(share * 100).toFixed(1)}%)`;
  });
  const legendWidth = Math.min(
    320,
    Math.max(...names.map((name) => Math.min(name.length, 44) * FONT_WIDTH + 24), 120),
  );
  const radius = Math.max(
    10,
    Math.min((width - legendWidth - PAD * 3) / 2, (height - PAD * 2) / 2),
  );
  const cx = PAD + radius;
  const cy = height / 2;
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    if (total <= 0 || value <= 0) {
      return;
    }
    const sweep = (value / total) * Math.PI * 2;
    const end = angle + sweep;
    const d =
      sweep >= Math.PI * 2 - 1e-9
        ? // A whole circle as two halves: one arc cannot start and end at the same point.
          `M ${round(cx)} ${round(cy - radius)} A ${round(radius)} ${round(radius)} 0 1 1 ${round(cx)} ${round(cy + radius)} A ${round(radius)} ${round(radius)} 0 1 1 ${round(cx)} ${round(cy - radius)} Z`
        : `M ${round(cx)} ${round(cy)} L ${round(cx + radius * Math.cos(angle))} ${round(cy + radius * Math.sin(angle))} A ${round(radius)} ${round(radius)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${round(cx + radius * Math.cos(end))} ${round(cy + radius * Math.sin(end))} Z`;
    shapes.push({ kind: 'arc', d, series: index % SERIES_COLORS });
    if (sweep / (Math.PI * 2) >= 0.05) {
      const middle = angle + sweep / 2;
      shapes.push({
        kind: 'text',
        x: round(cx + radius * 0.62 * Math.cos(middle)),
        y: round(cy + radius * 0.62 * Math.sin(middle) + 4),
        text: `${((value / total) * 100).toFixed(0)}%`,
        anchor: 'middle',
        ink: 'background',
      });
    }
    angle = end;
  });
  hits.push(...pieHits(cx, cy, radius, values, total));
  const legendX = cx + radius + PAD * 2;
  names.forEach((name, index) => {
    const y = Math.max(PAD, cy - (names.length * LINE) / 2) + index * LINE;
    shapes.push({
      kind: 'rect',
      x: legendX,
      y: y + 2,
      width: 10,
      height: 10,
      series: index % SERIES_COLORS,
    });
    shapes.push({
      kind: 'text',
      x: legendX + 14,
      y: y + 11,
      text: fit(name, width - legendX - 14 - PAD),
      anchor: 'start',
      ink: 'text',
    });
  });
  return {
    width,
    height,
    shapes,
    hits,
    plot: { left: cx - radius, top: cy - radius, right: cx + radius, bottom: cy + radius },
    xs: [],
  };
}

/** Boxes over each slice's middle, so the pointer finds a slice without arc maths. */
function pieHits(
  cx: number,
  cy: number,
  radius: number,
  values: readonly number[],
  total: number,
): Hit[] {
  const hits: Hit[] = [];
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    if (total <= 0 || value <= 0) {
      return;
    }
    const sweep = (value / total) * Math.PI * 2;
    const middle = angle + sweep / 2;
    const size = Math.max(12, Math.min(radius * 0.6, radius * sweep));
    hits.push({
      x: cx + radius * 0.6 * Math.cos(middle) - size / 2,
      y: cy + radius * 0.6 * Math.sin(middle) - size / 2,
      width: size,
      height: size,
      index,
      series: 0,
    });
    angle += sweep;
  });
  return hits;
}

/** The hit under the pointer: the last drawn wins, as it is on top. */
export function hitAt(scene: Scene, x: number, y: number): Hit | undefined {
  return [...scene.hits]
    .reverse()
    .find((hit) => x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

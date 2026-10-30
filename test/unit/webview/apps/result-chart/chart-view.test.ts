import { describe, expect, it } from 'vitest';
import type { ChartDataView } from '../../../../../src/shared/protocols/result-chart';
import {
  axisPositions,
  chartScene,
  fit,
  formatNumber,
  hitAt,
  niceTicks,
  type Shape,
  spacedLabels,
} from '../../../../../webview/src/apps/result-chart/chart-view';

const data = (parts: Partial<ChartDataView> = {}): ChartDataView => ({
  labels: ['a', 'b', 'c'],
  series: [{ name: 'v', values: [1, 3, 2] }],
  labelKind: 'text',
  points: 3,
  skipped: 0,
  ...parts,
});

const of = <K extends Shape['kind']>(shapes: readonly Shape[], kind: K) =>
  shapes.filter((shape): shape is Extract<Shape, { kind: K }> => shape.kind === kind);

describe('niceTicks', () => {
  it('steps in round numbers that cover the range', () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(3, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-40, 510)).toEqual([-200, 0, 200, 400, 600]);
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 0.03)).toEqual([0, 0.01, 0.02, 0.03]);
  });

  it('spreads around a single value and survives nonsense', () => {
    expect(niceTicks(5, 5)).toEqual([2.5, 5, 7.5]);
    expect(niceTicks(0, 0)).toEqual([-1, 0, 1]);
    expect(niceTicks(Number.NaN, 1)).toEqual([0]);
  });
});

describe('formatting', () => {
  it('writes big numbers short and small ones exactly enough', () => {
    expect(formatNumber(1500)).toBe('1,500');
    expect(formatNumber(25_000)).toBe('25K');
    expect(formatNumber(3_400_000)).toBe('3.4M');
    expect(formatNumber(0.125)).toBe('0.125');
    expect(formatNumber(1500, 'ru')).toMatch(/^1\s500$/u);
  });

  it('shortens labels to the room they have', () => {
    expect(fit('short', 100)).toBe('short');
    expect(fit('a very long label indeed', 60)).toMatch(/…$/u);
    expect(fit('abc', 1)).toBe('a…');
  });
});

describe('axisPositions and spacedLabels', () => {
  it('places numbers and times by value, so gaps show', () => {
    expect(axisPositions(['0', '1', '10'], 'number')).toEqual([0, 0.1, 1]);
    const times = axisPositions(['2026-01-01', '2026-01-02', '2026-01-11'], 'time');
    expect(times[1]).toBeCloseTo(0.1);
    expect(axisPositions(['2026-01-01 00:00:00+00', '2026-01-03 00:00:00+00'], 'time')).toEqual([
      0, 1,
    ]);
  });

  it('places labels evenly where any one has no value', () => {
    expect(axisPositions(['1', 'NULL', '3'], 'number')).toEqual([0, 0.5, 1]);
    expect(axisPositions(['x'], 'text')).toEqual([0.5]);
    expect(axisPositions(['5', '5'], 'number')).toEqual([0.5, 0.5]);
  });

  it('keeps labels far enough apart to read', () => {
    expect(spacedLabels([0, 10, 20, 60, 61, 130], 50)).toEqual([0, 3, 5]);
  });
});

describe('chartScene', () => {
  it('draws a line per series with points, a grid and labels', () => {
    const scene = chartScene({
      data: data(),
      kind: 'line',
      width: 600,
      height: 300,
      otherLabel: 'Other',
    });
    expect(of(scene.shapes, 'polyline')).toHaveLength(1);
    expect(of(scene.shapes, 'circle')).toHaveLength(3);
    const texts = of(scene.shapes, 'text').map((shape) => shape.text);
    // A line's axis spans its values; bars start at zero.
    expect(texts).toEqual(expect.arrayContaining(['v', 'a', 'b', 'c', '1', '3']));
    expect(scene.xs).toHaveLength(3);
    // The highest value is drawn highest.
    const [first, second] = of(scene.shapes, 'circle');
    expect(second?.cy ?? 0).toBeLessThan(first?.cy ?? 0);
  });

  it('breaks a line where a value is missing', () => {
    const scene = chartScene({
      data: data({
        labels: ['a', 'b', 'c', 'd', 'e'],
        series: [{ name: 'v', values: [1, 2, null, 3, 4] }],
      }),
      kind: 'line',
      width: 600,
      height: 300,
      otherLabel: 'Other',
    });
    expect(of(scene.shapes, 'polyline')).toHaveLength(2);
  });

  it('draws grouped bars from zero, down for negative values', () => {
    const scene = chartScene({
      data: data({
        series: [
          { name: 'x', values: [2, -1, null] },
          { name: 'y', values: [1, 1, 1] },
        ],
      }),
      kind: 'bar',
      width: 600,
      height: 300,
      otherLabel: 'Other',
    });
    const bars = of(scene.shapes, 'rect').filter((rect) => rect.width > 10);
    expect(bars).toHaveLength(5);
    const zero = of(scene.shapes, 'line').find(
      (line) => line.ink === 'axis' && line.y1 === line.y2,
    );
    const negative = bars.find((bar) => bar.series === 0 && bar.y >= (zero?.y1 ?? 0));
    expect(negative).toBeDefined();
    expect(scene.hits).toHaveLength(5);
    expect(hitAt(scene, (bars[0]?.x ?? 0) + 1, (bars[0]?.y ?? 0) + 1)).toMatchObject({
      index: 0,
      series: 0,
    });
  });

  it('draws pie slices with shares, the folded one named, a whole circle in two arcs', () => {
    const pie = chartScene({
      data: data({ labels: ['a', 'b', ''], series: [{ name: 'v', values: [3, 1, 1] }], folded: 4 }),
      kind: 'pie',
      width: 600,
      height: 300,
      otherLabel: 'Other',
    });
    expect(of(pie.shapes, 'arc')).toHaveLength(3);
    const texts = of(pie.shapes, 'text').map((shape) => shape.text);
    expect(texts).toEqual(expect.arrayContaining(['60%', 'a — 3 (60.0%)', 'Other — 1 (20.0%)']));
    expect(pie.hits).toHaveLength(3);
    const whole = chartScene({
      data: data({ labels: ['all'], series: [{ name: 'v', values: [5] }] }),
      kind: 'pie',
      width: 400,
      height: 300,
      otherLabel: 'Other',
    });
    expect(of(whole.shapes, 'arc')[0]?.d.match(/ A /gu)).toHaveLength(2);
  });

  it('pins labels at the edges inside the picture', () => {
    const scene = chartScene({
      data: data({
        labels: ['2026-01-01 long label', '2026-12-31 long label'],
        series: [{ name: 'v', values: [1, 2] }],
      }),
      kind: 'line',
      width: 300,
      height: 200,
      otherLabel: 'Other',
    });
    const labels = of(scene.shapes, 'text').filter((text) => text.text.startsWith('2026'));
    expect(labels.at(-1)?.anchor).toBe('end');
  });

  it('finds the nearest label of a line under the pointer, and nothing outside', () => {
    const scene = chartScene({
      data: data(),
      kind: 'line',
      width: 600,
      height: 300,
      otherLabel: 'Other',
    });
    expect(hitAt(scene, scene.xs[2] ?? 0, (scene.plot.top + scene.plot.bottom) / 2)?.index).toBe(2);
    expect(hitAt(scene, 1, 1)).toBeUndefined();
  });
});

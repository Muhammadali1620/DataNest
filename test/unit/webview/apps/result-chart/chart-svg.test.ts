import { describe, expect, it } from 'vitest';
import {
  type ChartColors,
  escapeXml,
  sceneToSvg,
  seriesColor,
} from '../../../../../webview/src/apps/result-chart/chart-svg';
import { chartScene } from '../../../../../webview/src/apps/result-chart/chart-view';

const COLORS: ChartColors = {
  ink: { axis: '#111', grid: '#222', text: '#333', muted: '#444', background: '#fff' },
  series: ['#a00', '#0a0'],
  font: 'Segoe "UI"',
};

describe('chart SVG', () => {
  it('escapes texts and drops control characters', () => {
    expect(escapeXml('a<b & "c">\u0001\td')).toBe('a&lt;b &amp; &quot;c&quot;&gt;\td');
  });

  it('cycles the series colours', () => {
    expect(seriesColor(COLORS, 0)).toBe('#a00');
    expect(seriesColor(COLORS, 3)).toBe('#0a0');
    expect(seriesColor({ ...COLORS, series: [] }, 1)).toBe('#3794ff');
  });

  it('writes the scene as a standalone picture in the theme colours', () => {
    const scene = chartScene({
      data: {
        labels: ['<x>', 'y'],
        series: [
          { name: 'a & b', values: [1, 2] },
          { name: 'c', values: [2, 1] },
        ],
        labelKind: 'text',
        points: 2,
        skipped: 0,
      },
      kind: 'bar',
      width: 500,
      height: 300,
      otherLabel: 'Other',
    });
    const svg = sceneToSvg(scene, COLORS);
    expect(svg).not.toContain('var(--');
    expect(svg).not.toContain('<script');
    expect(svg).toContain('fill="#a00"');
    expect(svg).toContain('fill="#0a0"');
    expect(svg).toContain('a &amp; b');
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(parsed.documentElement.getAttribute('width')).toBe('500');
    expect(parsed.documentElement.getAttribute('font-family')).toBe('Segoe "UI"');
  });

  it('writes lines and pies too', () => {
    for (const kind of ['line', 'pie'] as const) {
      const svg = sceneToSvg(
        chartScene({
          data: {
            labels: ['a', 'b'],
            series: [{ name: 'v', values: [1, 2] }],
            labelKind: 'text',
            points: 2,
            skipped: 0,
          },
          kind,
          width: 400,
          height: 300,
          otherLabel: 'Other',
        }),
        COLORS,
      );
      expect(svg).toContain(kind === 'line' ? '<polyline' : '<path');
      expect(
        new DOMParser().parseFromString(svg, 'image/svg+xml').getElementsByTagName('parsererror'),
      ).toHaveLength(0);
    }
  });
});

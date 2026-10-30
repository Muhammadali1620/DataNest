// The saved picture of a result chart (V8.7): the page's scene as a standalone SVG with
// the theme's colours written in, no CSS variables and no scripts.

import type { Ink, Scene, Shape } from './chart-view';

export interface ChartColors {
  readonly ink: Readonly<Record<Ink, string>>;
  readonly series: readonly string[];
  readonly font: string;
}

export function escapeXml(text: string): string {
  return (
    text
      // Control characters other than tab and line breaks are not allowed in XML.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      .replace(/"/gu, '&quot;')
  );
}

export function seriesColor(colors: ChartColors, series: number): string {
  return colors.series[series % Math.max(1, colors.series.length)] ?? '#3794ff';
}

function shapeSvg(shape: Shape, colors: ChartColors): string {
  switch (shape.kind) {
    case 'line':
      return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" stroke="${colors.ink[shape.ink]}" stroke-width="1"/>`;
    case 'polyline':
      return `<polyline points="${shape.points}" fill="none" stroke="${seriesColor(colors, shape.series)}" stroke-width="2" stroke-linejoin="round"/>`;
    case 'circle':
      return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" fill="${seriesColor(colors, shape.series)}"/>`;
    case 'rect':
      return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${seriesColor(colors, shape.series)}"/>`;
    case 'arc':
      return `<path d="${shape.d}" fill="${seriesColor(colors, shape.series)}" stroke="${colors.ink.background}" stroke-width="1"/>`;
    case 'text':
      return `<text x="${shape.x}" y="${shape.y}" text-anchor="${shape.anchor}" fill="${colors.ink[shape.ink]}">${escapeXml(shape.text)}</text>`;
  }
}

export function sceneToSvg(scene: Scene, colors: ChartColors): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" font-family="${escapeXml(colors.font)}" font-size="11">`,
    `<rect width="100%" height="100%" fill="${colors.ink.background}"/>`,
    ...scene.shapes.map((shape) => shapeSvg(shape, colors)),
    '</svg>',
  ].join('\n');
}

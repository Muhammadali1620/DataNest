import { describe, expect, it } from 'vitest';
import {
  addShape,
  type Design,
  emptyDesign,
  newPath,
  newText,
  type Shape,
} from '../../../../../src/shared/tools/svg-design/model';
import {
  colourOr,
  escapeXml,
  parseSvg,
  toSvg,
} from '../../../../../src/shared/tools/svg-design/svg';

const style = { fill: '#ff0000', stroke: '#000000', strokeWidth: 2, opacity: 1 };
const base = { ...style, rotation: 0 };

function sample(): Design {
  const shapes: Shape[] = [
    { id: 's1', kind: 'rect', x: 10, y: 20, w: 100, h: 50, radius: 8, ...base },
    { id: 's2', kind: 'circle', cx: 200, cy: 100, rx: 30, ry: 30, ...base, fill: '#00ff00' },
    { id: 's3', kind: 'ellipse', cx: 50, cy: 150, rx: 40, ry: 20, ...base, opacity: 0.5 },
    { id: 's4', kind: 'line', x1: 0, y1: 0, x2: 300, y2: 200, ...base, fill: 'none' },
    newText('s5', { x: 20, y: 250 }, 'Hello <&> "world"', style),
    newPath(
      's6',
      [
        { x: 5, y: 5 },
        { x: 60, y: 10 },
        { x: 30, y: 60 },
      ],
      true,
      style,
    ),
    newPath(
      's7',
      [
        { x: 100, y: 100 },
        { x: 150, y: 120 },
      ],
      false,
      style,
    ),
    {
      id: 's8',
      kind: 'rect',
      x: 120,
      y: 180,
      w: 60,
      h: 40,
      radius: 0,
      ...base,
      rotation: 30,
      stroke: 'none',
    },
  ];
  return { width: 400, height: 300, background: '#ffffff', shapes };
}

describe('toSvg', () => {
  it('writes a self-contained SVG with a background and every shape', () => {
    const svg = toSvg(sample());
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">',
      ),
    ).toBe(true);
    expect(svg).toContain('<rect id="background" width="400" height="300" fill="#ffffff"/>');
    expect(svg).toContain(
      '<rect id="s1" x="10" y="20" width="100" height="50" rx="8" fill="#ff0000" stroke="#000000" stroke-width="2"/>',
    );
    expect(svg).toContain('<circle id="s2" cx="200" cy="100" r="30"');
    expect(svg).toContain('<ellipse id="s3"');
    expect(svg).toContain('opacity="0.5"');
    expect(svg).toContain('<line id="s4"');
    expect(svg).toContain('<polygon id="s6" points="5,5 60,10 30,60"');
    expect(svg).toContain('<polyline id="s7"');
    expect(svg).toContain('transform="rotate(30 150 200)"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('escapes text and attribute values', () => {
    const svg = toSvg(sample());
    expect(svg).toContain('Hello &lt;&amp;&gt; &quot;world&quot;');
    expect(escapeXml(`a"b<c>&`)).toBe('a&quot;b&lt;c&gt;&amp;');
    const hostile = addShape(emptyDesign(), {
      id: 'x"/><script>',
      kind: 'rect',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      radius: 0,
      ...base,
      fill: '"/><script>',
    });
    expect(toSvg(hostile)).not.toContain('<script>');
  });

  it('has no background rectangle when there is none, and no stroke attributes without a stroke', () => {
    const svg = toSvg({ ...sample(), background: 'none' });
    expect(svg).not.toContain('id="background"');
    expect(toSvg(sample())).toContain(
      '<rect id="s8" x="120" y="180" width="60" height="40" fill="#ff0000" transform',
    );
  });
});

describe('parseSvg', () => {
  it('reads our own output back exactly', () => {
    const design = sample();
    const parsed = parseSvg(toSvg(design));
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.design.width).toBe(400);
    expect(parsed?.design.height).toBe(300);
    expect(parsed?.design.background).toBe('#ffffff');
    expect(parsed?.design.shapes).toHaveLength(design.shapes.length);
    parsed?.design.shapes.forEach((shape, i) => {
      const expected = design.shapes[i];
      expect(shape.kind).toBe(expected?.kind);
      expect(shape.fill).toBe(expected?.fill);
    });
    expect(parsed?.design.shapes[0]).toMatchObject({
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      radius: 8,
      stroke: '#000000',
      strokeWidth: 2,
    });
    expect(parsed?.design.shapes[4]).toMatchObject({ text: 'Hello <&> "world"', fontSize: 24 });
    expect(parsed?.design.shapes[5]).toMatchObject({ closed: true });
    expect(parsed?.design.shapes[7]).toMatchObject({ rotation: 30, x: 120, y: 180 });
    // and writes the same text again
    expect(toSvg(parsed?.design ?? emptyDesign())).toBe(toSvg(design));
  });

  it('reads other files: groups, translate, styles, units and defaults', () => {
    const parsed = parseSvg(`<?xml version="1.0"?>
      <!-- a comment -->
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:x="u" width="100px" height="80" viewBox="0 0 100 80">
        <g transform="translate(10 20)" fill="blue">
          <rect x="1" y="2" width="30" height="40" style="stroke: red; stroke-width: 3; opacity: 0.4"/>
          <circle cx="50" cy="50" r="5" fill="none"/>
        </g>
        <polygon points="0,0 10,0 10,10"/>
        <text x="5" y="30" font-size="12"><tspan>one</tspan> <tspan>two</tspan></text>
      </svg>`);
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.design).toMatchObject({ width: 100, height: 80, background: 'none' });
    const [rect, circle, polygon, text] = parsed?.design.shapes ?? [];
    expect(rect).toMatchObject({
      kind: 'rect',
      x: 11,
      y: 22,
      fill: 'blue',
      stroke: 'red',
      strokeWidth: 3,
      opacity: 0.4,
    });
    expect(circle).toMatchObject({ kind: 'circle', cx: 60, cy: 70, fill: 'none' });
    expect(polygon).toMatchObject({ kind: 'path', closed: true, fill: 'black' });
    expect(text).toMatchObject({ kind: 'text', text: 'one two', fontSize: 12 });
  });

  it('reads paths made of straight lines, absolute and relative', () => {
    const parsed = parseSvg(
      '<svg width="50" height="50"><path d="M10 10 L 20 10 h10 v 10 l-5 5 z" fill="red"/><path d="m5,5 10,0 0,10" /></svg>',
    );
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.design.shapes[0]).toMatchObject({
      kind: 'path',
      closed: true,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 30, y: 10 },
        { x: 30, y: 20 },
        { x: 25, y: 25 },
      ],
    });
    expect(parsed?.design.shapes[1]).toMatchObject({
      closed: false,
      points: [
        { x: 5, y: 5 },
        { x: 15, y: 5 },
        { x: 15, y: 15 },
      ],
    });
  });

  it('counts what it cannot draw', () => {
    const parsed = parseSvg(`<svg width="50" height="50"><defs><linearGradient id="g"/></defs>
      <path d="M0 0 C 10 10 20 20 30 30"/><image href="x.png"/><rect width="5" height="5" transform="scale(2)"/><rect width="5" height="5"/></svg>`);
    expect(parsed?.skipped).toBe(3);
    expect(parsed?.design.shapes.filter((s) => s.kind === 'rect')).toHaveLength(2);
  });

  it('takes the size from the viewBox and honours its origin', () => {
    const parsed = parseSvg(
      '<svg viewBox="10 20 200 100"><rect x="10" y="20" width="5" height="5"/></svg>',
    );
    expect(parsed?.design).toMatchObject({ width: 200, height: 100 });
    expect(parsed?.design.shapes[0]).toMatchObject({ x: 0, y: 0 });
    expect(parseSvg('<svg/>')?.design).toMatchObject({ width: 400, height: 300 });
    expect(parseSvg('<svg width="99999" height="5"/>')?.design).toMatchObject({
      width: 8192,
      height: 5,
    });
  });

  it('turns a rotation about a point into a turned shape', () => {
    const parsed = parseSvg(
      '<svg width="100" height="100"><rect x="0" y="0" width="20" height="20" transform="rotate(90 0 0)"/></svg>',
    );
    const shape = parsed?.design.shapes[0];
    expect(shape).toMatchObject({ kind: 'rect', rotation: 90 });
    // turned a quarter about the origin, its middle (10,10) goes to (-10,10)
    const rect = shape as { x: number; y: number; w: number; h: number };
    expect(rect.x + rect.w / 2).toBeCloseTo(-10);
    expect(rect.y + rect.h / 2).toBeCloseTo(10);
  });

  it('decodes entities and ignores scripts and DTDs', () => {
    const parsed = parseSvg(
      `<!DOCTYPE svg [<!ENTITY a "b">]><svg width="10" height="10"><text x="0" y="5">a &amp; b &#65; &#x42; &unknown;</text><script>alert(1)</script></svg>`,
    );
    expect(parsed?.design.shapes[0]).toMatchObject({ text: 'a & b A B &unknown;' });
    expect(parsed?.skipped).toBe(1);
  });

  it('refuses what is not an SVG', () => {
    expect(parseSvg('')).toBeUndefined();
    expect(parseSvg('hello')).toBeUndefined();
    expect(parseSvg('<html></html>')).toBeUndefined();
    expect(parseSvg(`<svg>${' '.repeat(4_000_001)}</svg>`)).toBeUndefined();
  });

  it('keeps only plain colours', () => {
    expect(colourOr('#abc', 'x')).toBe('#abc');
    expect(colourOr('rgb(1, 2, 3)', 'x')).toBe('rgb(1, 2, 3)');
    expect(colourOr('url(#grad)', 'x')).toBe('x');
    expect(colourOr('red;} body{', 'x')).toBe('x');
    expect(colourOr(undefined, 'x')).toBe('x');
    const parsed = parseSvg(
      '<svg width="9" height="9"><rect width="3" height="3" fill="url(#g)"/><rect width="1" height="1" fill="none" stroke="rgb(0,0,0)"/></svg>',
    );
    expect(parsed?.design.shapes[0]).toMatchObject({ fill: 'black' });
  });

  it('reads the first full-size rectangle as the background', () => {
    expect(
      parseSvg(
        '<svg width="20" height="10"><rect width="20" height="10" fill="#abcdef"/><rect width="5" height="5"/></svg>',
      )?.design,
    ).toMatchObject({ background: '#abcdef' });
    const kept = parseSvg(
      '<svg width="20" height="10"><rect width="20" height="10" fill="#abcdef" stroke="red"/></svg>',
    );
    expect(kept?.design.background).toBe('none');
    expect(kept?.design.shapes).toHaveLength(1);
  });
});

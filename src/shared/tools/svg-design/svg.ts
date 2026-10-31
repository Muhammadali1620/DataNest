// The designer's drawing as SVG text and back: our own output reads back exactly, and other
// SVG files read as far as they use simple shapes (rect, circle, ellipse, line, polyline,
// polygon, text and paths of straight lines).

import {
  centreOf,
  boxOf,
  type Design,
  emptyDesign,
  MAX_SHAPES,
  MAX_SIDE,
  nextId,
  type Point,
  rotatePoint,
  type Shape,
  translate,
} from './model';

export interface ParsedDesign {
  readonly design: Design;
  /** Elements the designer cannot draw (curves, images, gradients…) and left out. */
  readonly skipped: number;
}

const num = (value: number): string => String(Math.round(value * 100) / 100);

export function escapeXml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

const SAFE_COLOUR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,30}|(?:rgb|hsl)a?\([0-9a-z.,%\s/-]{3,40}\))$/iu;

/** A colour as written in the file, or the fallback when it is not a plain colour. */
export function colourOr(value: string | undefined, fallback: string): string {
  const text = (value ?? '').trim();
  return SAFE_COLOUR.test(text) ? text : fallback;
}

function look(shape: Shape): string {
  let out = ` fill="${escapeXml(shape.fill)}"`;
  if (shape.stroke !== 'none' && shape.strokeWidth > 0) {
    out += ` stroke="${escapeXml(shape.stroke)}" stroke-width="${num(shape.strokeWidth)}"`;
  }
  if (shape.opacity !== 1) {
    out += ` opacity="${num(shape.opacity)}"`;
  }
  if (shape.rotation !== 0) {
    const c = centreOf(boxOf(shape));
    out += ` transform="rotate(${num(shape.rotation)} ${num(c.x)} ${num(c.y)})"`;
  }
  return out;
}

function shapeToSvg(shape: Shape): string {
  const id = ` id="${escapeXml(shape.id)}"`;
  switch (shape.kind) {
    case 'rect':
      return `<rect${id} x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.w)}" height="${num(shape.h)}"${
        shape.radius > 0 ? ` rx="${num(shape.radius)}"` : ''
      }${look(shape)}/>`;
    case 'circle':
      return `<circle${id} cx="${num(shape.cx)}" cy="${num(shape.cy)}" r="${num(shape.rx)}"${look(shape)}/>`;
    case 'ellipse':
      return `<ellipse${id} cx="${num(shape.cx)}" cy="${num(shape.cy)}" rx="${num(shape.rx)}" ry="${num(shape.ry)}"${look(shape)}/>`;
    case 'line':
      return `<line${id} x1="${num(shape.x1)}" y1="${num(shape.y1)}" x2="${num(shape.x2)}" y2="${num(shape.y2)}"${look(shape)}/>`;
    case 'text':
      return `<text${id} x="${num(shape.x)}" y="${num(shape.y)}" font-size="${num(shape.fontSize)}" font-family="sans-serif"${look(shape)}>${escapeXml(shape.text)}</text>`;
    case 'path': {
      const points = shape.points.map((p) => `${num(p.x)},${num(p.y)}`).join(' ');
      return `<${shape.closed ? 'polygon' : 'polyline'}${id} points="${points}"${look(shape)}/>`;
    }
  }
}

export function toSvg(design: Design): string {
  const { width, height } = design;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  if (design.background !== 'none') {
    lines.push(
      `  <rect id="background" width="${width}" height="${height}" fill="${escapeXml(design.background)}"/>`,
    );
  }
  for (const shape of design.shapes) {
    lines.push(`  ${shapeToSvg(shape)}`);
  }
  lines.push('</svg>');
  return lines.join('\n');
}

// ---- A small XML reader: enough for SVG text, no DTDs, no scripts, nothing external.

interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  /** Text and child elements in the order they appear. */
  readonly parts: (string | XmlNode)[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseXml(source: string): XmlNode | undefined {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], parts: [] };
  const stack: XmlNode[] = [root];
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!(?:DOCTYPE|ENTITY)[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gu;
  for (const match of source.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      return undefined;
    }
    const [, cdata, closing, opening, rawAttrs, selfClose, text] = match;
    if (cdata !== undefined) {
      top.parts.push(cdata);
    } else if (closing !== undefined) {
      if (stack.length > 1) {
        stack.pop();
      }
    } else if (opening !== undefined) {
      const attrs: Record<string, string> = {};
      for (const attr of (rawAttrs ?? '').matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
        const name = (attr[1] ?? '').replace(/^.*:/u, '');
        attrs[name] = decode(attr[2] ?? attr[3] ?? '');
      }
      const node: XmlNode = { name: opening.replace(/^.*:/u, ''), attrs, children: [], parts: [] };
      top.children.push(node);
      top.parts.push(node);
      if (selfClose !== '/') {
        stack.push(node);
      }
    } else if (text !== undefined) {
      top.parts.push(decode(text));
    }
  }
  return root.children.find((node) => node.name === 'svg');
}

// ---- Reading shapes

function number(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function styleOf(node: XmlNode): Record<string, string> {
  const own: Record<string, string> = { ...node.attrs };
  for (const part of (node.attrs.style ?? '').split(';')) {
    const at = part.indexOf(':');
    if (at > 0) {
      own[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
  }
  return own;
}

interface Inherited {
  readonly dx: number;
  readonly dy: number;
  readonly fill?: string;
  readonly stroke?: string;
}

function transformOf(text: string | undefined): {
  rotate?: { angle: number; about?: Point };
  dx: number;
  dy: number;
  unsupported: boolean;
} {
  let dx = 0;
  let dy = 0;
  let unsupported = false;
  let rotate: { angle: number; about?: Point } | undefined;
  for (const part of (text ?? '').matchAll(/([a-z]+)\s*\(([^)]*)\)/giu)) {
    const args = (part[2] ?? '')
      .split(/[\s,]+/u)
      .filter((arg) => arg !== '')
      .map(Number);
    const name = (part[1] ?? '').toLowerCase();
    if (name === 'translate') {
      dx += args[0] ?? 0;
      dy += args[1] ?? 0;
    } else if (name === 'rotate' && rotate === undefined) {
      const [angle = 0, ax, ay] = args;
      rotate =
        ax === undefined || ay === undefined ? { angle } : { angle, about: { x: ax, y: ay } };
    } else {
      unsupported = true;
    }
  }
  return { ...(rotate === undefined ? {} : { rotate }), dx, dy, unsupported };
}

function straightPath(d: string): { points: Point[]; closed: boolean } | undefined {
  const points: Point[] = [];
  let closed = false;
  let current: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  for (const command of d.matchAll(/([a-z])([^a-z]*)/giu)) {
    const letter = command[1] ?? '';
    const args = (command[2] ?? '')
      .trim()
      .split(/[\s,]+/u)
      .filter((arg) => arg !== '')
      .map(Number);
    if (args.some((arg) => !Number.isFinite(arg))) {
      return undefined;
    }
    const relative = letter === letter.toLowerCase();
    const upper = letter.toUpperCase();
    if (upper === 'Z') {
      closed = true;
      current = start;
    } else if (upper === 'M' || upper === 'L') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        current = {
          x: (relative ? current.x : 0) + (args[i] ?? 0),
          y: (relative ? current.y : 0) + (args[i + 1] ?? 0),
        };
        points.push(current);
        if (upper === 'M' && i === 0) {
          start = current;
        }
      }
    } else if (upper === 'H' || upper === 'V') {
      for (const value of args) {
        current =
          upper === 'H'
            ? { x: (relative ? current.x : 0) + value, y: current.y }
            : { x: current.x, y: (relative ? current.y : 0) + value };
        points.push(current);
      }
    } else {
      return undefined;
    }
  }
  return points.length >= 2 ? { points, closed } : undefined;
}

function pointsOf(text: string | undefined): Point[] {
  const values = (text ?? '')
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  const out: Point[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const x = values[i];
    const y = values[i + 1];
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      out.push({ x, y });
    }
  }
  return out;
}

/** The id the file gives a shape when it is a plain, unused name; else a fresh one. */
function idOf(wanted: string | undefined, design: Design): string {
  return wanted !== undefined &&
    /^[A-Za-z][\w-]{0,40}$/u.test(wanted) &&
    !design.shapes.some((shape) => shape.id === wanted)
    ? wanted
    : nextId(design);
}

function textOf(node: XmlNode): string {
  return node.parts
    .map((part) => (typeof part === 'string' ? part : textOf(part)))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function parseSvg(source: string): ParsedDesign | undefined {
  if (source.length > 4_000_000) {
    return undefined;
  }
  const svg = parseXml(source);
  if (svg === undefined) {
    return undefined;
  }
  const box = (svg.attrs.viewBox ?? '')
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  const [vx = 0, vy = 0, vw, vh] = box.length === 4 && box.every(Number.isFinite) ? box : [];
  const clampSide = (value: number | undefined, fallback: number): number =>
    value !== undefined && value > 0 ? Math.min(MAX_SIDE, Math.round(value)) : fallback;
  let design = emptyDesign(
    clampSide(number(svg.attrs.width, Number.NaN) || vw, 400),
    clampSide(number(svg.attrs.height, Number.NaN) || vh, 300),
    'none',
  );
  let skipped = 0;

  const add = (shape: Shape): void => {
    if (design.shapes.length < MAX_SHAPES) {
      design = { ...design, shapes: [...design.shapes, shape] };
    }
  };

  const visit = (node: XmlNode, inherited: Inherited): void => {
    const own = styleOf(node);
    const t = transformOf(node.attrs.transform);
    if (t.unsupported && node.name !== 'g' && node.name !== 'svg') {
      skipped++;
    }
    const here: Inherited = {
      dx: inherited.dx + t.dx,
      dy: inherited.dy + t.dy,
      ...(own.fill === undefined
        ? inherited.fill === undefined
          ? {}
          : { fill: inherited.fill }
        : { fill: own.fill }),
      ...(own.stroke === undefined
        ? inherited.stroke === undefined
          ? {}
          : { stroke: inherited.stroke }
        : { stroke: own.stroke }),
    };
    if (node.name === 'g' || node.name === 'svg' || node.name === 'a') {
      node.children.forEach((child) => {
        visit(child, here);
      });
      return;
    }
    const common = {
      id: idOf(node.attrs.id, design),
      fill: here.fill === undefined ? 'black' : colourOr(here.fill, 'black'),
      stroke: colourOr(here.stroke, 'none'),
      strokeWidth: Math.max(0, number(own['stroke-width'], 1)),
      opacity: Math.max(0, Math.min(1, number(own.opacity, 1))),
      rotation: 0,
    };
    let shape: Shape | undefined;
    const a = node.attrs;
    switch (node.name) {
      case 'rect':
        shape = {
          ...common,
          kind: 'rect',
          x: number(a.x),
          y: number(a.y),
          w: Math.max(0, number(a.width)),
          h: Math.max(0, number(a.height)),
          radius: Math.max(0, number(a.rx ?? a.ry)),
        };
        break;
      case 'circle':
        shape = {
          ...common,
          kind: 'circle',
          cx: number(a.cx),
          cy: number(a.cy),
          rx: Math.max(0, number(a.r)),
          ry: Math.max(0, number(a.r)),
        };
        break;
      case 'ellipse':
        shape = {
          ...common,
          kind: 'ellipse',
          cx: number(a.cx),
          cy: number(a.cy),
          rx: Math.max(0, number(a.rx)),
          ry: Math.max(0, number(a.ry)),
        };
        break;
      case 'line':
        shape = {
          ...common,
          kind: 'line',
          fill: 'none',
          x1: number(a.x1),
          y1: number(a.y1),
          x2: number(a.x2),
          y2: number(a.y2),
        };
        break;
      case 'polyline':
      case 'polygon': {
        const points = pointsOf(a.points);
        shape =
          points.length >= 2
            ? {
                ...common,
                kind: 'path',
                points,
                closed: node.name === 'polygon',
                fill: node.name === 'polygon' ? common.fill : 'none',
              }
            : undefined;
        break;
      }
      case 'path': {
        const parsed = straightPath(a.d ?? '');
        shape =
          parsed === undefined
            ? undefined
            : {
                ...common,
                kind: 'path',
                points: parsed.points,
                closed: parsed.closed,
                fill: parsed.closed ? common.fill : 'none',
              };
        break;
      }
      case 'text':
        shape = {
          ...common,
          kind: 'text',
          x: number(a.x),
          y: number(a.y),
          text: textOf(node).slice(0, 1000),
          fontSize: Math.max(4, number(own['font-size'], 16)),
        };
        break;
      case 'defs':
      case 'title':
      case 'desc':
      case 'metadata':
      case 'style':
        return;
      default:
        skipped++;
        return;
    }
    if (shape === undefined) {
      skipped++;
      return;
    }
    let placed = translate(shape, here.dx - vx, here.dy - vy);
    if (t.rotate !== undefined) {
      const centre = centreOf(boxOf(placed));
      const about =
        t.rotate.about === undefined
          ? centre
          : {
              x: t.rotate.about.x + here.dx - vx - t.dx,
              y: t.rotate.about.y + here.dy - vy - t.dy,
            };
      const moved = rotatePoint(centre, about, t.rotate.angle);
      placed = {
        ...translate(placed, moved.x - centre.x, moved.y - centre.y),
        rotation: ((t.rotate.angle % 360) + 360) % 360,
      };
    }
    add(placed);
  };

  visit(svg, { dx: 0, dy: 0 });
  // Our own output (and many files) start with a rectangle the size of the canvas: that is the background.
  const first = design.shapes[0];
  if (
    first?.kind === 'rect' &&
    first.x === 0 &&
    first.y === 0 &&
    first.w === design.width &&
    first.h === design.height &&
    first.stroke === 'none' &&
    first.rotation === 0 &&
    first.opacity === 1 &&
    first.fill !== 'none'
  ) {
    design = { ...design, background: first.fill, shapes: design.shapes.slice(1) };
  }
  return { design, skipped };
}

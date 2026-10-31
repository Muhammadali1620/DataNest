// The drawing of the SVG designer as plain data, and every change to it as a pure function:
// the page keeps the current document and a history of earlier ones.

export type ShapeKind = 'rect' | 'circle' | 'ellipse' | 'line' | 'text' | 'path';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Common {
  readonly id: string;
  /** `none` or a CSS colour. */
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number;
  /** Degrees, about the middle of the shape's box. */
  readonly rotation: number;
}

export interface RectShape extends Common {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radius: number;
}

export interface EllipseShape extends Common {
  readonly kind: 'circle' | 'ellipse';
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface LineShape extends Common {
  readonly kind: 'line';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface TextShape extends Common {
  readonly kind: 'text';
  readonly x: number;
  /** The baseline. */
  readonly y: number;
  readonly text: string;
  readonly fontSize: number;
}

export interface PathShape extends Common {
  readonly kind: 'path';
  readonly points: readonly Point[];
  readonly closed: boolean;
}

export type Shape = RectShape | EllipseShape | LineShape | TextShape | PathShape;

export interface Design {
  readonly width: number;
  readonly height: number;
  /** `none` or a colour. */
  readonly background: string;
  /** Bottom first. */
  readonly shapes: readonly Shape[];
}

export const MAX_SHAPES = 2000;
export const MAX_SIDE = 8192;
export const MIN_SIZE = 1;

export const DEFAULT_STYLE = {
  fill: '#409eff',
  stroke: '#1f4f8f',
  strokeWidth: 2,
  opacity: 1,
  rotation: 0,
} as const;

export function emptyDesign(width = 400, height = 300, background = '#ffffff'): Design {
  return { width, height, background, shapes: [] };
}

export function nextId(design: Design): string {
  const used = new Set(design.shapes.map((shape) => shape.id));
  let n = design.shapes.length + 1;
  while (used.has(`s${n}`)) {
    n++;
  }
  return `s${n}`;
}

const clampNumber = (value: number, low: number, high: number): number =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : low;

// ---- Geometry of one shape

/** Approximate text width: the page measures nothing, so a fixed advance per character. */
export function textWidth(text: string, fontSize: number): number {
  return Math.max(1, text.length) * fontSize * 0.58;
}

/** The shape's box before its rotation. */
export function boxOf(shape: Shape): Box {
  switch (shape.kind) {
    case 'rect':
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    case 'circle':
    case 'ellipse':
      return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, w: shape.rx * 2, h: shape.ry * 2 };
    case 'line':
      return {
        x: Math.min(shape.x1, shape.x2),
        y: Math.min(shape.y1, shape.y2),
        w: Math.abs(shape.x2 - shape.x1),
        h: Math.abs(shape.y2 - shape.y1),
      };
    case 'text':
      return {
        x: shape.x,
        y: shape.y - shape.fontSize,
        w: textWidth(shape.text, shape.fontSize),
        h: shape.fontSize * 1.25,
      };
    case 'path': {
      const xs = shape.points.map((p) => p.x);
      const ys = shape.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

export function centreOf(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

export function rotatePoint(point: Point, about: Point, degrees: number): Point {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - about.x;
  const dy = point.y - about.y;
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
}

/** The four corners of the shape's box where they are drawn, rotation included. */
export function cornersOf(shape: Shape): Point[] {
  const box = boxOf(shape);
  const centre = centreOf(box);
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((corner) => rotatePoint(corner, centre, shape.rotation));
}

/** The smallest box around the drawn shape. */
export function drawnBox(shape: Shape): Box {
  const corners = cornersOf(shape);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insidePolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      a !== undefined &&
      b !== undefined &&
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** True when a point (in drawing units) is on the shape; `tolerance` widens thin lines. */
export function hits(shape: Shape, point: Point, tolerance = 4): boolean {
  const box = boxOf(shape);
  const local = rotatePoint(point, centreOf(box), -shape.rotation);
  const reach = shape.strokeWidth / 2 + tolerance;
  const filled = shape.fill !== 'none';
  switch (shape.kind) {
    case 'rect': {
      const inside =
        local.x >= box.x - reach &&
        local.x <= box.x + box.w + reach &&
        local.y >= box.y - reach &&
        local.y <= box.y + box.h + reach;
      if (!inside) {
        return false;
      }
      if (filled) {
        return true;
      }
      return (
        local.x - box.x <= reach ||
        box.x + box.w - local.x <= reach ||
        local.y - box.y <= reach ||
        box.y + box.h - local.y <= reach
      );
    }
    case 'circle':
    case 'ellipse': {
      const rx = Math.max(shape.rx, 0.5);
      const ry = Math.max(shape.ry, 0.5);
      const norm = Math.hypot(
        (local.x - shape.cx) / (rx + reach),
        (local.y - shape.cy) / (ry + reach),
      );
      if (norm > 1) {
        return false;
      }
      if (filled) {
        return true;
      }
      return (
        Math.hypot(
          (local.x - shape.cx) / Math.max(0.5, rx - reach),
          (local.y - shape.cy) / Math.max(0.5, ry - reach),
        ) >= 1
      );
    }
    case 'line':
      return (
        distanceToSegment(local, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <=
        reach
      );
    case 'text':
      return (
        local.x >= box.x && local.x <= box.x + box.w && local.y >= box.y && local.y <= box.y + box.h
      );
    case 'path': {
      const points = shape.points;
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (a !== undefined && b !== undefined && distanceToSegment(local, a, b) <= reach) {
          return true;
        }
      }
      const first = points[0];
      const last = points[points.length - 1];
      if (shape.closed && first !== undefined && last !== undefined) {
        if (distanceToSegment(local, last, first) <= reach) {
          return true;
        }
        return filled && insidePolygon(local, points);
      }
      return false;
    }
  }
}

/** The id of the topmost shape at a point. */
export function pick(design: Design, point: Point, tolerance = 4): string | undefined {
  for (let i = design.shapes.length - 1; i >= 0; i--) {
    const shape = design.shapes[i];
    if (shape !== undefined && hits(shape, point, tolerance)) {
      return shape.id;
    }
  }
  return undefined;
}

// ---- Changes to one shape

export function translate(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.kind) {
    case 'rect':
    case 'text':
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case 'circle':
    case 'ellipse':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
    case 'line':
      return {
        ...shape,
        x1: shape.x1 + dx,
        y1: shape.y1 + dy,
        x2: shape.x2 + dx,
        y2: shape.y2 + dy,
      };
    case 'path':
      return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

/** The shape fitted into a new box: the same drawing stretched from the old box. */
export function fitTo(shape: Shape, to: Box): Shape {
  const from = boxOf(shape);
  const w = Math.max(MIN_SIZE, to.w);
  const h = Math.max(MIN_SIZE, to.h);
  const sx = from.w === 0 ? 1 : w / from.w;
  const sy = from.h === 0 ? 1 : h / from.h;
  const mapX = (x: number): number => (from.w === 0 ? to.x : to.x + (x - from.x) * sx);
  const mapY = (y: number): number => (from.h === 0 ? to.y : to.y + (y - from.y) * sy);
  switch (shape.kind) {
    case 'rect':
      return { ...shape, x: to.x, y: to.y, w, h, radius: Math.min(shape.radius, w / 2, h / 2) };
    case 'circle':
      // A circle stays one: the larger of the two sides decides.
      return {
        ...shape,
        cx: to.x + w / 2,
        cy: to.y + h / 2,
        rx: Math.max(w, h) / 2,
        ry: Math.max(w, h) / 2,
      };
    case 'ellipse':
      return { ...shape, cx: to.x + w / 2, cy: to.y + h / 2, rx: w / 2, ry: h / 2 };
    case 'line':
      return {
        ...shape,
        x1: mapX(shape.x1),
        y1: mapY(shape.y1),
        x2: mapX(shape.x2),
        y2: mapY(shape.y2),
      };
    case 'text': {
      const size = Math.max(4, shape.fontSize * (from.h === 0 ? 1 : h / from.h));
      return { ...shape, x: to.x, y: to.y + size, fontSize: size };
    }
    case 'path':
      return { ...shape, points: shape.points.map((p) => ({ x: mapX(p.x), y: mapY(p.y) })) };
  }
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * A handle of the box dragged by (dx, dy) in drawing units. The drag is read in the shape's
 * own, unrotated frame; the opposite corner stays where it is drawn.
 */
export function resizeBy(
  shape: Shape,
  handle: Handle,
  dx: number,
  dy: number,
  keepRatio = false,
): Shape {
  const box = boxOf(shape);
  const centre = centreOf(box);
  const local = rotatePoint({ x: centre.x + dx, y: centre.y + dy }, centre, -shape.rotation);
  const ldx = local.x - centre.x;
  const ldy = local.y - centre.y;
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (handle.includes('w')) {
    left = Math.min(left + ldx, right - MIN_SIZE);
  }
  if (handle.includes('e')) {
    right = Math.max(right + ldx, left + MIN_SIZE);
  }
  if (handle.includes('n')) {
    top = Math.min(top + ldy, bottom - MIN_SIZE);
  }
  if (handle.includes('s')) {
    bottom = Math.max(bottom + ldy, top + MIN_SIZE);
  }
  if (keepRatio && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    const w = right - left;
    const h = bottom - top;
    if (handle === 'n' || handle === 's') {
      const nw = h * ratio;
      left = (left + right) / 2 - nw / 2;
      right = left + nw;
    } else if (handle === 'e' || handle === 'w') {
      const nh = w / ratio;
      top = (top + bottom) / 2 - nh / 2;
      bottom = top + nh;
    } else {
      // A corner scales by whichever side the pointer pulled further.
      const scale = Math.max(w / box.w, h / box.h);
      if (handle.includes('w')) {
        left = right - box.w * scale;
      } else {
        right = left + box.w * scale;
      }
      if (handle.includes('n')) {
        top = bottom - box.h * scale;
      } else {
        bottom = top + box.h * scale;
      }
    }
  }
  const resized = fitTo(shape, { x: left, y: top, w: right - left, h: bottom - top });
  if (shape.rotation === 0) {
    return resized;
  }
  // Keep the opposite corner (or side middle) where it was drawn, whatever the rotation did.
  const anchorOf = (b: Box): Point => ({
    x: handle.includes('w') ? b.x + b.w : handle.includes('e') ? b.x : b.x + b.w / 2,
    y: handle.includes('n') ? b.y + b.h : handle.includes('s') ? b.y : b.y + b.h / 2,
  });
  const before = rotatePoint(anchorOf(box), centre, shape.rotation);
  const after = anchorOf(boxOf(resized));
  const afterDrawn = rotatePoint(after, centreOf(boxOf(resized)), shape.rotation);
  return translate(resized, before.x - afterDrawn.x, before.y - afterDrawn.y);
}

export function rotateTo(shape: Shape, degrees: number): Shape {
  const normal = ((degrees % 360) + 360) % 360;
  return { ...shape, rotation: Math.round(normal * 10) / 10 };
}

/** The angle, in degrees, of the line from the shape's centre to a point; 0 is straight up. */
export function angleToPoint(shape: Shape, point: Point): number {
  const centre = centreOf(boxOf(shape));
  return (Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI + 90;
}

// ---- Changes to the design

export function addShape(design: Design, shape: Shape): Design {
  return design.shapes.length >= MAX_SHAPES
    ? design
    : { ...design, shapes: [...design.shapes, shape] };
}

export function replaceShape(design: Design, shape: Shape): Design {
  return { ...design, shapes: design.shapes.map((item) => (item.id === shape.id ? shape : item)) };
}

export function removeShapes(design: Design, ids: ReadonlySet<string>): Design {
  return { ...design, shapes: design.shapes.filter((shape) => !ids.has(shape.id)) };
}

/** A copy of the shapes, offset, with fresh ids; returns the new design and the new ids. */
export function duplicateShapes(
  design: Design,
  ids: ReadonlySet<string>,
  offset = 12,
): { design: Design; ids: string[] } {
  let result = design;
  const created: string[] = [];
  for (const shape of design.shapes) {
    if (ids.has(shape.id) && result.shapes.length < MAX_SHAPES) {
      const copy = { ...translate(shape, offset, offset), id: nextId(result) };
      result = addShape(result, copy);
      created.push(copy.id);
    }
  }
  return { design: result, ids: created };
}

export type Order = 'front' | 'forward' | 'backward' | 'back';

export function reorder(design: Design, ids: ReadonlySet<string>, order: Order): Design {
  const shapes = [...design.shapes];
  const moving = shapes.filter((shape) => ids.has(shape.id));
  if (moving.length === 0) {
    return design;
  }
  if (order === 'front') {
    return { ...design, shapes: [...shapes.filter((shape) => !ids.has(shape.id)), ...moving] };
  }
  if (order === 'back') {
    return { ...design, shapes: [...moving, ...shapes.filter((shape) => !ids.has(shape.id))] };
  }
  const step = order === 'forward' ? 1 : -1;
  const indices = shapes.map((_, i) => i);
  for (const i of order === 'forward' ? indices.reverse() : indices) {
    const shape = shapes[i];
    const other = shapes[i + step];
    if (shape !== undefined && ids.has(shape.id) && other !== undefined && !ids.has(other.id)) {
      shapes[i] = other;
      shapes[i + step] = shape;
    }
  }
  return { ...design, shapes };
}

export function resizeCanvas(design: Design, width: number, height: number): Design {
  return {
    ...design,
    width: Math.round(clampNumber(width, 1, MAX_SIDE)),
    height: Math.round(clampNumber(height, 1, MAX_SIDE)),
  };
}

/** The box around all the given shapes as drawn. */
export function selectionBox(design: Design, ids: ReadonlySet<string>): Box | undefined {
  const boxes = design.shapes.filter((shape) => ids.has(shape.id)).map(drawnBox);
  if (boxes.length === 0) {
    return undefined;
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

/** Rounds a coordinate to a grid step; a step of 0 leaves it alone. */
export function snap(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

// ---- New shapes from a drag

export function shapeFromDrag(
  kind: Exclude<ShapeKind, 'path' | 'text'>,
  id: string,
  from: Point,
  to: Point,
  style: Pick<Common, 'fill' | 'stroke' | 'strokeWidth' | 'opacity'>,
  shift = false,
): Shape {
  const common = { id, ...style, rotation: 0 };
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  if (shift && kind !== 'line') {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  const x = Math.min(from.x, from.x + dx);
  const y = Math.min(from.y, from.y + dy);
  const w = Math.abs(dx);
  const h = Math.abs(dy);
  if (kind === 'rect') {
    return { ...common, kind, x, y, w, h, radius: 0 };
  }
  if (kind === 'line') {
    return { ...common, kind, fill: 'none', x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  }
  if (kind === 'circle') {
    const r = Math.max(w, h) / 2;
    return { ...common, kind, cx: x + w / 2, cy: y + h / 2, rx: r, ry: r };
  }
  return { ...common, kind, cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
}

export function newText(
  id: string,
  at: Point,
  text: string,
  style: Pick<Common, 'fill' | 'stroke' | 'strokeWidth' | 'opacity'>,
): TextShape {
  return {
    id,
    kind: 'text',
    ...style,
    stroke: 'none',
    strokeWidth: 0,
    rotation: 0,
    x: at.x,
    y: at.y,
    text,
    fontSize: 24,
  };
}

export function newPath(
  id: string,
  points: readonly Point[],
  closed: boolean,
  style: Pick<Common, 'fill' | 'stroke' | 'strokeWidth' | 'opacity'>,
): PathShape {
  return {
    id,
    kind: 'path',
    ...style,
    fill: closed ? style.fill : 'none',
    rotation: 0,
    points,
    closed,
  };
}

// ---- History

export interface History {
  readonly past: readonly Design[];
  readonly present: Design;
  readonly future: readonly Design[];
}

export const HISTORY_LIMIT = 100;

export function startHistory(design: Design): History {
  return { past: [], present: design, future: [] };
}

/** Makes `next` the present; a change that changes nothing adds no step. */
export function commit(history: History, next: Design): History {
  if (next === history.present) {
    return history;
  }
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  return previous === undefined
    ? history
    : {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  return next === undefined
    ? history
    : { past: [...history.past, history.present], present: next, future: rest };
}

/** Replaces the present without a new step: a slider or a colour dragged is one change. */
export function replacePresent(history: History, next: Design): History {
  return next === history.present ? history : { ...history, present: next };
}

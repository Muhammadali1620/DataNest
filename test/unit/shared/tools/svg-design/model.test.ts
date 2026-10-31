import { describe, expect, it } from 'vitest';
import {
  addShape,
  angleToPoint,
  boxOf,
  centreOf,
  commit,
  cornersOf,
  type Design,
  drawnBox,
  duplicateShapes,
  emptyDesign,
  fitTo,
  HISTORY_LIMIT,
  hits,
  MAX_SHAPES,
  newPath,
  newText,
  nextId,
  pick,
  redo,
  replacePresent,
  removeShapes,
  reorder,
  replaceShape,
  resizeBy,
  resizeCanvas,
  rotatePoint,
  rotateTo,
  type Shape,
  selectionBox,
  shapeFromDrag,
  snap,
  startHistory,
  translate,
  undo,
} from '../../../../../src/shared/tools/svg-design/model';

const style = { fill: '#ff0000', stroke: '#000000', strokeWidth: 2, opacity: 1 };
type Extra = Record<string, unknown>;
const rect = (id: string, x = 0, y = 0, w = 100, h = 50, extra: Extra = {}): Shape =>
  ({
    id,
    kind: 'rect',
    x,
    y,
    w,
    h,
    radius: 0,
    ...style,
    rotation: 0,
    ...extra,
  }) as unknown as Shape;
const circle = (id: string, cx = 50, cy = 50, r = 25): Shape => ({
  id,
  kind: 'circle',
  cx,
  cy,
  rx: r,
  ry: r,
  ...style,
  rotation: 0,
});
const line = (id: string): Shape => ({
  id,
  kind: 'line',
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 0,
  ...style,
  fill: 'none',
  rotation: 0,
});

describe('boxes', () => {
  it('knows the box of every kind', () => {
    expect(boxOf(rect('a', 10, 20, 30, 40))).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(boxOf(circle('c', 50, 60, 10))).toEqual({ x: 40, y: 50, w: 20, h: 20 });
    expect(boxOf({ ...circle('e'), kind: 'ellipse', rx: 30, ry: 10 } as Shape)).toEqual({
      x: 20,
      y: 40,
      w: 60,
      h: 20,
    });
    expect(boxOf({ ...line('l'), x1: 90, y1: 40, x2: 10, y2: 10 } as Shape)).toEqual({
      x: 10,
      y: 10,
      w: 80,
      h: 30,
    });
    const text = newText('t', { x: 10, y: 50 }, 'abcd', style);
    expect(boxOf(text).x).toBe(10);
    expect(boxOf(text).y).toBe(26);
    expect(boxOf(text).w).toBeGreaterThan(0);
    const path = newPath(
      'p',
      [
        { x: 5, y: 5 },
        { x: 25, y: 45 },
        { x: 15, y: 10 },
      ],
      false,
      style,
    );
    expect(boxOf(path)).toEqual({ x: 5, y: 5, w: 20, h: 40 });
  });

  it('rotates points and corners', () => {
    const turned = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    expect(turned.x).toBeCloseTo(0);
    expect(turned.y).toBeCloseTo(10);
    const drawn = drawnBox(rect('a', 0, 0, 100, 50, { rotation: 90 }));
    expect(drawn.w).toBeCloseTo(50);
    expect(drawn.h).toBeCloseTo(100);
    expect(cornersOf(rect('a'))).toHaveLength(4);
    expect(centreOf({ x: 10, y: 10, w: 20, h: 40 })).toEqual({ x: 20, y: 30 });
  });
});

describe('hit testing', () => {
  it('hits the inside of a filled shape and not outside it', () => {
    expect(hits(rect('a'), { x: 50, y: 25 })).toBe(true);
    expect(hits(rect('a'), { x: 200, y: 25 })).toBe(false);
    expect(hits(circle('c'), { x: 50, y: 50 })).toBe(true);
    expect(hits(circle('c'), { x: 0, y: 0 })).toBe(false);
  });

  it('hits only the outline of a shape with no fill', () => {
    const hollow = rect('a', 0, 0, 100, 100, { fill: 'none' });
    expect(hits(hollow, { x: 50, y: 50 })).toBe(false);
    expect(hits(hollow, { x: 1, y: 50 })).toBe(true);
    const ring = { ...circle('c'), fill: 'none' } as Shape;
    expect(hits(ring, { x: 50, y: 50 })).toBe(false);
    expect(hits(ring, { x: 75, y: 50 })).toBe(true);
  });

  it('hits a thin line within the tolerance', () => {
    expect(hits(line('l'), { x: 50, y: 3 })).toBe(true);
    expect(hits(line('l'), { x: 50, y: 20 })).toBe(false);
    expect(hits(line('l'), { x: 120, y: 0 })).toBe(false);
  });

  it('follows the rotation', () => {
    const turned = rect('a', 0, 0, 100, 10, { rotation: 90 });
    // turned about (50,5): now tall and thin around x = 50
    expect(hits(turned, { x: 50, y: -30 })).toBe(true);
    expect(hits(turned, { x: 5, y: 5 })).toBe(false);
  });

  it('hits paths: the edges, and the inside when closed and filled', () => {
    const open = newPath(
      'p',
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      false,
      style,
    );
    expect(hits(open, { x: 50, y: 2 })).toBe(true);
    expect(hits(open, { x: 50, y: 60 })).toBe(false);
    const closed = newPath(
      'q',
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      true,
      style,
    );
    expect(hits(closed, { x: 80, y: 40 })).toBe(true);
    expect(hits(closed, { x: 10, y: 80 })).toBe(false);
    expect(hits(closed, { x: 50, y: 52 })).toBe(true);
  });

  it('hits text by its box', () => {
    const text = newText('t', { x: 10, y: 50 }, 'hello', style);
    expect(hits(text, { x: 20, y: 40 })).toBe(true);
    expect(hits(text, { x: 300, y: 40 })).toBe(false);
  });

  it('picks the topmost shape', () => {
    const design: Design = {
      ...emptyDesign(),
      shapes: [rect('under'), rect('over', 10, 10, 20, 20)],
    };
    expect(pick(design, { x: 15, y: 15 })).toBe('over');
    expect(pick(design, { x: 90, y: 40 })).toBe('under');
    expect(pick(design, { x: 300, y: 300 })).toBeUndefined();
  });
});

describe('moving and resizing', () => {
  it('translates every kind', () => {
    expect(translate(rect('a'), 5, 6)).toMatchObject({ x: 5, y: 6 });
    expect(translate(circle('c'), 5, 6)).toMatchObject({ cx: 55, cy: 56 });
    expect(translate(line('l'), 5, 6)).toMatchObject({ x1: 5, y1: 6, x2: 105, y2: 6 });
    expect(translate(newText('t', { x: 1, y: 2 }, 'a', style), 5, 6)).toMatchObject({ x: 6, y: 8 });
    expect(
      translate(
        newPath(
          'p',
          [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
          false,
          style,
        ),
        1,
        1,
      ),
    ).toMatchObject({
      points: [
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
    });
  });

  it('fits a shape into a new box', () => {
    expect(fitTo(rect('a'), { x: 10, y: 10, w: 40, h: 20 })).toMatchObject({
      x: 10,
      y: 10,
      w: 40,
      h: 20,
    });
    expect(fitTo(circle('c'), { x: 0, y: 0, w: 40, h: 20 })).toMatchObject({ rx: 20, ry: 20 });
    expect(
      fitTo({ ...circle('e'), kind: 'ellipse' } as Shape, { x: 0, y: 0, w: 40, h: 20 }),
    ).toMatchObject({
      rx: 20,
      ry: 10,
    });
    expect(fitTo(line('l'), { x: 0, y: 0, w: 50, h: 0 })).toMatchObject({ x1: 0, x2: 50 });
    const path = fitTo(
      newPath(
        'p',
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        false,
        style,
      ),
      { x: 0, y: 0, w: 100, h: 100 },
    );
    expect(path).toMatchObject({
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    });
    const text = fitTo(newText('t', { x: 0, y: 24 }, 'a', style), { x: 0, y: 0, w: 10, h: 60 });
    expect((text as { fontSize: number }).fontSize).toBeGreaterThan(24);
    expect(
      fitTo(rect('r', 0, 0, 100, 50, { radius: 40 }), {
        x: 0,
        y: 0,
        w: 20,
        h: 20,
      }),
    ).toMatchObject({ radius: 10 });
  });

  it('resizes by a handle and keeps the far side', () => {
    expect(resizeBy(rect('a'), 'e', 20, 0)).toMatchObject({ x: 0, w: 120, h: 50 });
    expect(resizeBy(rect('a'), 'w', -20, 0)).toMatchObject({ x: -20, w: 120 });
    expect(resizeBy(rect('a'), 'se', 10, 10)).toMatchObject({ w: 110, h: 60 });
    expect(resizeBy(rect('a'), 'nw', 10, 10)).toMatchObject({ x: 10, y: 10, w: 90, h: 40 });
    expect(resizeBy(rect('a'), 'e', -500, 0)).toMatchObject({ w: 1 });
  });

  it('keeps the ratio on request', () => {
    const next = resizeBy(rect('a', 0, 0, 100, 50), 'se', 50, 0, true) as { w: number; h: number };
    expect(next.w / next.h).toBeCloseTo(2);
    const side = resizeBy(rect('a', 0, 0, 100, 50), 'e', 100, 0, true) as {
      w: number;
      h: number;
      y: number;
    };
    expect(side.w).toBe(200);
    expect(side.h).toBe(100);
    expect(side.y).toBe(-25);
  });

  it('keeps the opposite corner where it is drawn for a rotated shape', () => {
    const turned = rect('a', 0, 0, 100, 50, { rotation: 30 });
    const before = cornersOf(turned)[0];
    const after = cornersOf(resizeBy(turned, 'se', 20, 10));
    expect(after[0]?.x).toBeCloseTo(before?.x ?? 0, 5);
    expect(after[0]?.y).toBeCloseTo(before?.y ?? 0, 5);
  });

  it('rotates to a normal angle', () => {
    expect(rotateTo(rect('a'), 450).rotation).toBe(90);
    expect(rotateTo(rect('a'), -90).rotation).toBe(270);
    expect(rotateTo(rect('a'), 12.34).rotation).toBe(12.3);
    expect(angleToPoint(rect('a', 0, 0, 100, 100), { x: 50, y: -50 })).toBeCloseTo(0);
    expect(angleToPoint(rect('a', 0, 0, 100, 100), { x: 150, y: 50 })).toBeCloseTo(90);
  });
});

describe('the design', () => {
  const a = rect('s1');
  const b = circle('s2');
  const c = line('s3');
  const base: Design = { ...emptyDesign(), shapes: [a, b, c] };

  it('makes fresh ids', () => {
    expect(nextId(emptyDesign())).toBe('s1');
    expect(nextId(base)).toBe('s4');
    expect(nextId({ ...emptyDesign(), shapes: [rect('s2')] })).toBe('s3');
  });

  it('adds, replaces and removes', () => {
    expect(addShape(emptyDesign(), a).shapes).toEqual([a]);
    expect(replaceShape(base, { ...a, fill: '#00ff00' }).shapes[0]).toMatchObject({
      fill: '#00ff00',
    });
    expect(removeShapes(base, new Set(['s2'])).shapes.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('refuses shapes beyond the limit', () => {
    const full: Design = {
      ...emptyDesign(),
      shapes: Array.from({ length: MAX_SHAPES }, (_, i) => rect(`s${i + 1}`)),
    };
    expect(addShape(full, rect('extra')).shapes).toHaveLength(MAX_SHAPES);
    expect(duplicateShapes(full, new Set(['s1'])).ids).toEqual([]);
  });

  it('duplicates with new ids and an offset', () => {
    const { design, ids } = duplicateShapes(base, new Set(['s1', 's2']));
    expect(ids).toEqual(['s4', 's5']);
    expect(design.shapes).toHaveLength(5);
    expect(design.shapes[3]).toMatchObject({ x: 12, y: 12 });
  });

  it('orders shapes', () => {
    const ids = (d: Design): string[] => d.shapes.map((s) => s.id);
    expect(ids(reorder(base, new Set(['s1']), 'front'))).toEqual(['s2', 's3', 's1']);
    expect(ids(reorder(base, new Set(['s3']), 'back'))).toEqual(['s3', 's1', 's2']);
    expect(ids(reorder(base, new Set(['s1']), 'forward'))).toEqual(['s2', 's1', 's3']);
    expect(ids(reorder(base, new Set(['s3']), 'backward'))).toEqual(['s1', 's3', 's2']);
    expect(ids(reorder(base, new Set(['s3']), 'forward'))).toEqual(['s1', 's2', 's3']);
    expect(ids(reorder(base, new Set(['s1', 's2']), 'forward'))).toEqual(['s3', 's1', 's2']);
    expect(reorder(base, new Set(['nope']), 'front')).toBe(base);
  });

  it('resizes the canvas within limits', () => {
    expect(resizeCanvas(base, 800, 600)).toMatchObject({ width: 800, height: 600 });
    expect(resizeCanvas(base, -5, 99999)).toMatchObject({ width: 1, height: 8192 });
    expect(resizeCanvas(base, Number.NaN, 10.4)).toMatchObject({ width: 1, height: 10 });
  });

  it('boxes a selection', () => {
    expect(selectionBox(base, new Set(['s1', 's2']))).toEqual({ x: 0, y: 0, w: 100, h: 75 });
    expect(selectionBox(base, new Set())).toBeUndefined();
  });

  it('snaps to a grid', () => {
    expect(snap(13, 10)).toBe(10);
    expect(snap(16, 10)).toBe(20);
    expect(snap(13, 0)).toBe(13);
  });
});

describe('new shapes', () => {
  it('draws from a drag in any direction', () => {
    expect(shapeFromDrag('rect', 'a', { x: 50, y: 50 }, { x: 10, y: 20 }, style)).toMatchObject({
      x: 10,
      y: 20,
      w: 40,
      h: 30,
    });
    expect(shapeFromDrag('ellipse', 'a', { x: 0, y: 0 }, { x: 40, y: 20 }, style)).toMatchObject({
      cx: 20,
      cy: 10,
      rx: 20,
      ry: 10,
    });
    expect(shapeFromDrag('circle', 'a', { x: 0, y: 0 }, { x: 40, y: 20 }, style)).toMatchObject({
      rx: 20,
      ry: 20,
    });
    expect(shapeFromDrag('line', 'a', { x: 1, y: 2 }, { x: 30, y: 40 }, style)).toMatchObject({
      x1: 1,
      y1: 2,
      x2: 30,
      y2: 40,
      fill: 'none',
    });
  });

  it('draws a square with shift', () => {
    expect(shapeFromDrag('rect', 'a', { x: 0, y: 0 }, { x: 40, y: 10 }, style, true)).toMatchObject(
      { w: 40, h: 40 },
    );
    expect(
      shapeFromDrag('rect', 'a', { x: 0, y: 0 }, { x: -40, y: 10 }, style, true),
    ).toMatchObject({ x: -40, w: 40, h: 40 });
  });

  it('makes text and paths', () => {
    expect(newText('t', { x: 1, y: 2 }, 'hi', style)).toMatchObject({
      kind: 'text',
      text: 'hi',
      stroke: 'none',
    });
    expect(
      newPath(
        'p',
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        false,
        style,
      ),
    ).toMatchObject({ fill: 'none' });
    expect(
      newPath(
        'p',
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 2 },
        ],
        true,
        style,
      ),
    ).toMatchObject({ fill: '#ff0000' });
  });
});

describe('history', () => {
  const d0 = emptyDesign();
  const d1 = addShape(d0, rect('s1'));
  const d2 = addShape(d1, rect('s2'));

  it('undoes and redoes', () => {
    let history = startHistory(d0);
    history = commit(commit(history, d1), d2);
    expect(history.present).toBe(d2);
    history = undo(history);
    expect(history.present).toBe(d1);
    history = undo(history);
    expect(history.present).toBe(d0);
    expect(undo(history)).toBe(history);
    history = redo(redo(history));
    expect(history.present).toBe(d2);
    expect(redo(history)).toBe(history);
  });

  it('drops the redo steps on a new change and ignores a change that is none', () => {
    let history = commit(commit(startHistory(d0), d1), d2);
    history = undo(history);
    expect(commit(history, history.present)).toBe(history);
    history = commit(history, addShape(d1, rect('other')));
    expect(history.future).toEqual([]);
  });

  it('replaces the present without adding a step', () => {
    const history = commit(startHistory(d0), d1);
    const same = replacePresent(history, history.present);
    expect(same).toBe(history);
    const next = replacePresent(history, d2);
    expect(next.present).toBe(d2);
    expect(next.past).toEqual(history.past);
    expect(undo(next).present).toBe(d0);
  });

  it('keeps only so many steps', () => {
    let history = startHistory(d0);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      history = commit(history, resizeCanvas(history.present, 10 + i, 10));
    }
    expect(history.past).toHaveLength(HISTORY_LIMIT);
  });
});

import { describe, expect, it } from 'vitest';
import {
  LAYOUT_GAPS,
  layoutDiagram,
  type LayoutBox,
  type Point,
} from '../../../../../webview/src/apps/er-diagram/layout';

const box = (id: string, width = 160, height = 100): LayoutBox => ({ id, width, height });

function overlaps(boxes: readonly LayoutBox[], at: ReadonlyMap<string, Point>): string[] {
  const found: string[] = [];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const pa = at.get(a.id);
      const pb = at.get(b.id);
      if (pa === undefined || pb === undefined) {
        continue;
      }
      const apart =
        pa.x + a.width <= pb.x ||
        pb.x + b.width <= pa.x ||
        pa.y + a.height <= pb.y ||
        pb.y + b.height <= pa.y;
      if (!apart) {
        found.push(`${a.id}/${b.id}`);
      }
    }
  }
  return found;
}

describe('layoutDiagram', () => {
  it('places nothing for an empty diagram', () => {
    expect(layoutDiagram([], []).size).toBe(0);
  });

  it('puts a referenced table left of the tables that point at it', () => {
    const boxes = [box('order_items'), box('orders'), box('customers'), box('products')];
    const at = layoutDiagram(boxes, [
      { from: 'orders', to: 'customers' },
      { from: 'order_items', to: 'orders' },
      { from: 'order_items', to: 'products' },
    ]);
    const x = (id: string): number => at.get(id)?.x ?? NaN;
    expect(x('customers')).toBeLessThan(x('orders'));
    expect(x('orders')).toBeLessThan(x('order_items'));
    expect(x('products')).toBeLessThan(x('order_items'));
    expect(x('orders') - x('customers')).toBeGreaterThanOrEqual(160 + LAYOUT_GAPS.layer);
  });

  it('never lets boxes overlap, whatever their sizes', () => {
    const boxes = Array.from({ length: 40 }, (_, index) =>
      box(`t${index}`, 120 + ((index * 37) % 200), 40 + ((index * 53) % 300)),
    );
    const edges = boxes.slice(1).map((one, index) => ({
      from: one.id,
      to: `t${Math.floor(index / 3)}`,
    }));
    const at = layoutDiagram(boxes, edges);
    expect(at.size).toBe(40);
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it('starts the picture at 0,0 with whole-pixel positions', () => {
    const boxes = [box('a'), box('b'), box('c')];
    const at = layoutDiagram(boxes, [{ from: 'b', to: 'a' }]);
    const points = [...at.values()];
    expect(Math.min(...points.map((point) => point.x))).toBe(0);
    expect(Math.min(...points.map((point) => point.y))).toBe(0);
    expect(points.every((point) => Number.isInteger(point.x) && Number.isInteger(point.y))).toBe(
      true,
    );
  });

  it('survives cycles and tables that point at themselves', () => {
    const boxes = [box('a'), box('b'), box('c')];
    const at = layoutDiagram(boxes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'a', to: 'a' },
    ]);
    expect(at.size).toBe(3);
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it('ignores keys to boxes it does not know', () => {
    const at = layoutDiagram([box('a')], [{ from: 'a', to: 'ghost' }]);
    expect([...at.keys()]).toEqual(['a']);
  });

  it('puts tables tied to nothing in a grid after the connected groups', () => {
    const lonely = Array.from({ length: 9 }, (_, index) => box(`solo${index}`, 100, 50));
    const boxes = [...lonely, box('parent'), box('child')];
    const at = layoutDiagram(boxes, [{ from: 'child', to: 'parent' }]);
    const xs = new Set(lonely.map((one) => at.get(one.id)?.x));
    const ys = new Set(lonely.map((one) => at.get(one.id)?.y));
    // Nine boxes: three columns of three.
    expect(xs.size).toBe(3);
    expect(ys.size).toBe(3);
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it('keeps separate groups apart', () => {
    const boxes = [box('a1'), box('a2'), box('b1'), box('b2')];
    const at = layoutDiagram(boxes, [
      { from: 'a2', to: 'a1' },
      { from: 'b2', to: 'b1' },
    ]);
    expect(overlaps(boxes, at)).toEqual([]);
    const a = [at.get('a1'), at.get('a2')];
    const b = [at.get('b1'), at.get('b2')];
    const right = (points: (Point | undefined)[]) =>
      Math.max(...points.map((point) => (point?.x ?? 0) + 160));
    const left = (points: (Point | undefined)[]) =>
      Math.min(...points.map((point) => point?.x ?? 0));
    const bottom = (points: (Point | undefined)[]) =>
      Math.max(...points.map((point) => (point?.y ?? 0) + 100));
    const top = (points: (Point | undefined)[]) =>
      Math.min(...points.map((point) => point?.y ?? 0));
    const separated =
      left(b) >= right(a) + LAYOUT_GAPS.group - 1 || top(b) >= bottom(a) + LAYOUT_GAPS.group - 1;
    expect(separated).toBe(true);
  });

  it('gives the same picture for the same input', () => {
    const boxes = Array.from({ length: 15 }, (_, index) => box(`t${index}`));
    const edges = [
      { from: 't3', to: 't1' },
      { from: 't4', to: 't1' },
      { from: 't5', to: 't2' },
      { from: 't6', to: 't3' },
      { from: 't6', to: 't5' },
    ];
    expect([...layoutDiagram(boxes, edges)]).toEqual([...layoutDiagram(boxes, edges)]);
  });

  it('lays out a few hundred tables quickly', () => {
    const boxes = Array.from({ length: 600 }, (_, index) => box(`t${index}`));
    const edges = boxes.slice(1).map((one, index) => ({ from: one.id, to: `t${index % 50}` }));
    const started = performance.now();
    const at = layoutDiagram(boxes, edges);
    expect(at.size).toBe(600);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

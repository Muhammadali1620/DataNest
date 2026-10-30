// Automatic layout of an ER diagram (V8.1). Tables that reference each other form
// groups; inside a group, a referenced table stands left of the tables that point at
// it (layers by longest path), the order inside a layer follows the neighbours, and
// every box sits near the boxes it is tied to. Groups are packed in rows; tables
// tied to nothing go last, in a grid. Deterministic: the same input, the same picture.

export interface LayoutBox {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** `from` holds a key that points at `to`. */
export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const LAYOUT_GAPS = {
  /** Between layers of a group, room for the lines. */
  layer: 90,
  /** Between boxes of one layer. */
  box: 36,
  /** Between groups. */
  group: 80,
} as const;

/** Barycenter sweeps; more rarely changes anything on real schemas. */
const SWEEPS = 6;

export function layoutDiagram(
  boxes: readonly LayoutBox[],
  edges: readonly LayoutEdge[],
): Map<string, Point> {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const links = edges.filter(
    (edge) => edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to),
  );
  const groups = components(boxes, links);
  const placed: { positions: Map<string, Point>; width: number; height: number }[] = [];
  const lonely: LayoutBox[] = [];
  for (const group of groups) {
    const [only] = group;
    if (group.length === 1 && only !== undefined) {
      lonely.push(only);
      continue;
    }
    const ids = new Set(group.map((box) => box.id));
    placed.push(
      layoutGroup(
        group,
        links.filter((edge) => ids.has(edge.from)),
      ),
    );
  }
  if (lonely.length > 0) {
    placed.push(grid(lonely));
  }
  return pack(placed);
}

/** Connected groups, the biggest first; boxes keep their input order inside. */
function components(boxes: readonly LayoutBox[], edges: readonly LayoutEdge[]): LayoutBox[][] {
  const parent = new Map(boxes.map((box) => [box.id, box.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }
    parent.set(id, root);
    return root;
  };
  for (const edge of edges) {
    const a = find(edge.from);
    const b = find(edge.to);
    if (a !== b) {
      parent.set(b, a);
    }
  }
  const groups = new Map<string, LayoutBox[]>();
  for (const box of boxes) {
    const root = find(box.id);
    const group = groups.get(root) ?? [];
    group.push(box);
    groups.set(root, group);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

function layoutGroup(
  boxes: readonly LayoutBox[],
  edges: readonly LayoutEdge[],
): { positions: Map<string, Point>; width: number; height: number } {
  const layerOf = layers(boxes, edges);
  const count = Math.max(...layerOf.values()) + 1;
  const columns: LayoutBox[][] = Array.from({ length: count }, () => []);
  for (const box of boxes) {
    columns[layerOf.get(box.id) ?? 0]?.push(box);
  }
  const neighbours = new Map<string, string[]>(boxes.map((box) => [box.id, []]));
  for (const edge of edges) {
    neighbours.get(edge.from)?.push(edge.to);
    neighbours.get(edge.to)?.push(edge.from);
  }
  order(columns, neighbours);

  const heights = new Map(boxes.map((box) => [box.id, box.height]));
  const positions = new Map<string, Point>();
  let x = 0;
  for (const column of columns) {
    const width = Math.max(...column.map((box) => box.width));
    // Where each box would like to be: level with the boxes it is tied to.
    const wishes = column.map((box) => {
      const placedNeighbours = (neighbours.get(box.id) ?? [])
        .map((id) => ({ id, at: positions.get(id) }))
        .filter((entry): entry is { id: string; at: Point } => entry.at !== undefined);
      if (placedNeighbours.length === 0) {
        return undefined;
      }
      const centers = placedNeighbours.map(
        (entry) => entry.at.y + (heights.get(entry.id) ?? 0) / 2,
      );
      return centers.reduce((sum, value) => sum + value, 0) / centers.length - box.height / 2;
    });
    let bottom = -Infinity;
    for (const [index, box] of column.entries()) {
      const wish = wishes[index] ?? (bottom === -Infinity ? 0 : bottom + LAYOUT_GAPS.box);
      const y = bottom === -Infinity ? wish : Math.max(wish, bottom + LAYOUT_GAPS.box);
      positions.set(box.id, { x, y });
      bottom = y + box.height;
    }
    x += width + LAYOUT_GAPS.layer;
  }
  return normalize(positions, boxes);
}

/**
 * Layer 0 holds tables that point at nothing; every other table stands one layer
 * right of the furthest table it points at. Keys that close a cycle are ignored.
 */
function layers(boxes: readonly LayoutBox[], edges: readonly LayoutEdge[]): Map<string, number> {
  const targets = new Map<string, string[]>(boxes.map((box) => [box.id, []]));
  for (const edge of edges) {
    targets.get(edge.from)?.push(edge.to);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) {
      return known;
    }
    visiting.add(id);
    let value = 0;
    for (const target of targets.get(id) ?? []) {
      if (!visiting.has(target)) {
        value = Math.max(value, visit(target) + 1);
      }
    }
    visiting.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const box of boxes) {
    visit(box.id);
  }
  return layer;
}

/** Sorts each layer by the mean position of its neighbours, sweeping right and back. */
function order(columns: LayoutBox[][], neighbours: ReadonlyMap<string, readonly string[]>): void {
  const rank = new Map<string, number>();
  const remember = (): void => {
    for (const column of columns) {
      for (const [index, box] of column.entries()) {
        rank.set(box.id, index);
      }
    }
  };
  remember();
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const forward = sweep % 2 === 0;
    const indexes = columns.map((_, index) => index);
    for (const index of forward ? indexes.slice(1) : indexes.reverse().slice(1)) {
      const side = new Set((columns[forward ? index - 1 : index + 1] ?? []).map((box) => box.id));
      const column = columns[index] ?? [];
      const keyed = column.map((box, at) => {
        const ranks = (neighbours.get(box.id) ?? [])
          .filter((id) => side.has(id))
          .map((id) => rank.get(id) ?? 0);
        const center =
          ranks.length === 0 ? at : ranks.reduce((sum, value) => sum + value, 0) / ranks.length;
        return { box, center, at };
      });
      keyed.sort((a, b) => a.center - b.center || a.at - b.at);
      columns[index] = keyed.map((entry) => entry.box);
      remember();
    }
  }
}

/** Tables tied to nothing: a grid about as wide as it is tall. */
function grid(boxes: readonly LayoutBox[]): {
  positions: Map<string, Point>;
  width: number;
  height: number;
} {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(boxes.length)));
  const positions = new Map<string, Point>();
  const columnWidths: number[] = [];
  for (const [index, box] of boxes.entries()) {
    const column = index % perRow;
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, box.width);
  }
  let y = 0;
  for (let start = 0; start < boxes.length; start += perRow) {
    const row = boxes.slice(start, start + perRow);
    let x = 0;
    for (const [column, box] of row.entries()) {
      positions.set(box.id, { x, y });
      x += (columnWidths[column] ?? box.width) + LAYOUT_GAPS.box;
    }
    y += Math.max(...row.map((box) => box.height)) + LAYOUT_GAPS.box;
  }
  return normalize(positions, boxes);
}

/** Moves a group to start at 0,0 and measures it. */
function normalize(
  positions: Map<string, Point>,
  boxes: readonly LayoutBox[],
): { positions: Map<string, Point>; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    const at = positions.get(box.id) ?? { x: 0, y: 0 };
    minX = Math.min(minX, at.x);
    minY = Math.min(minY, at.y);
    maxX = Math.max(maxX, at.x + box.width);
    maxY = Math.max(maxY, at.y + box.height);
  }
  const moved = new Map<string, Point>();
  for (const [id, at] of positions) {
    moved.set(id, { x: at.x - minX, y: at.y - minY });
  }
  return { positions: moved, width: maxX - minX, height: maxY - minY };
}

/** Groups in rows, left to right, wrapping at about the width of a square of their area. */
function pack(
  groups: readonly { positions: Map<string, Point>; width: number; height: number }[],
): Map<string, Point> {
  const area = groups.reduce((sum, group) => sum + group.width * group.height, 0);
  const widest = Math.max(0, ...groups.map((group) => group.width));
  const limit = Math.max(widest, Math.sqrt(area) * 1.6);
  const result = new Map<string, Point>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const group of groups) {
    if (x > 0 && x + group.width > limit) {
      x = 0;
      y += rowHeight + LAYOUT_GAPS.group;
      rowHeight = 0;
    }
    for (const [id, at] of group.positions) {
      result.set(id, { x: Math.round(at.x + x), y: Math.round(at.y + y) });
    }
    x += group.width + LAYOUT_GAPS.group;
    rowHeight = Math.max(rowHeight, group.height);
  }
  return result;
}

// Geometry of the ER diagram (V8.1): how big a box is, where a column's row sits,
// how a line runs between two boxes and what its ends look like. The page draws from
// these, and the SVG export writes the same shapes with the theme's colours.

import type {
  ErDetails,
  ErDiagramRelation,
  ErDiagramTable,
} from '../../../../src/shared/protocols/er-diagram';
import type { Point } from './layout';

export const BOX = {
  header: 30,
  row: 22,
  padding: 10,
  /** Room for the key mark before a column name. */
  icon: 18,
  /** Between a column name and its type. */
  gap: 24,
  minWidth: 140,
  maxWidth: 460,
  /** Rounded corners, as the page's cards have. */
  radius: 6,
} as const;

/** Text width in pixels; the page measures with the editor font, tests count characters. */
export type Measure = (text: string, bold?: boolean) => number;

export const charMeasure: Measure = (text, bold = false) => text.length * (bold ? 7.8 : 7.2);

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BoxRow {
  /** Shortened to the box; the full texts go in the tooltip. */
  readonly name: string;
  readonly type: string;
  readonly mark: 'PK' | 'FK' | '';
  readonly title: string;
}

export interface BoxText {
  readonly label: string;
  readonly rows: readonly BoxRow[];
}

/** The columns a box lists for the chosen detail. A table elsewhere shows what it has. */
export function visibleColumns(
  table: ErDiagramTable,
  details: ErDetails,
): ErDiagramTable['columns'] {
  if (details === 'names') {
    return [];
  }
  if (details === 'keys' && table.external !== true) {
    return table.columns.filter((column) => column.primaryKey || column.foreignKey);
  }
  return table.columns;
}

/** Shortens text with `…` until it fits; the full text is in the tooltip. */
export function fit(text: string, width: number, measure: Measure, bold = false): string {
  if (measure(text, bold) <= width) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, middle)}…`, bold) <= width) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${text.slice(0, low)}…`;
}

export function boxSize(
  table: ErDiagramTable,
  details: ErDetails,
  measure: Measure,
): { width: number; height: number } {
  const columns = visibleColumns(table, details);
  let width = measure(table.label, true) + BOX.padding * 2;
  for (const column of columns) {
    const type = column.dataType === '' ? 0 : BOX.gap + measure(column.dataType);
    width = Math.max(width, BOX.padding * 2 + BOX.icon + measure(column.name) + type);
  }
  return {
    width: Math.ceil(Math.min(BOX.maxWidth, Math.max(BOX.minWidth, width))),
    height: BOX.header + columns.length * BOX.row + (columns.length > 0 ? BOX.padding / 2 : 0),
  };
}

/** The label and column texts shortened to the box. */
export function boxText(
  table: ErDiagramTable,
  details: ErDetails,
  width: number,
  measure: Measure,
): BoxText {
  const inner = width - BOX.padding * 2;
  return {
    label: fit(table.label, inner, measure, true),
    rows: visibleColumns(table, details).map((column): BoxRow => {
      const name = fit(column.name, inner - BOX.icon, measure);
      const room = inner - BOX.icon - measure(name) - BOX.gap;
      return {
        name,
        type: column.dataType === '' || room <= 0 ? '' : fit(column.dataType, room, measure),
        mark: column.primaryKey ? 'PK' : column.foreignKey ? 'FK' : '',
        title: [
          column.name,
          column.dataType,
          column.nullable || column.dataType === '' ? '' : 'NOT NULL',
        ]
          .filter((part) => part !== '')
          .join(' '),
      };
    }),
  };
}

/** The vertical middle of a column's row, or of the header when the row is not shown. */
export function rowCenter(
  box: Box,
  table: ErDiagramTable,
  column: string | undefined,
  details: ErDetails,
): number {
  const index =
    column === undefined
      ? -1
      : visibleColumns(table, details).findIndex((candidate) => candidate.name === column);
  return index < 0 ? box.y + BOX.header / 2 : box.y + BOX.header + index * BOX.row + BOX.row / 2;
}

export interface RelationShape {
  /** The line as an SVG path. */
  readonly path: string;
  /** Crow's foot (and a ring when optional) at the table that holds the key. */
  readonly many: string;
  readonly optionalRing?: Point;
  /** A bar at the referenced table. */
  readonly one: string;
}

const STUB = 14;

/**
 * Lines leave and enter at the sides that face each other; boxes above or below each
 * other (or a table pointing at itself) are joined round their right sides.
 */
export function relationShape(
  from: Box,
  fromY: number,
  to: Box,
  toY: number,
  optional: boolean,
  self: boolean,
): RelationShape {
  let start: Point;
  let end: Point;
  let startDir: 1 | -1;
  let endDir: 1 | -1;
  if (!self && from.x >= to.x + to.width + STUB * 2) {
    start = { x: from.x, y: fromY };
    end = { x: to.x + to.width, y: toY };
    startDir = -1;
    endDir = 1;
  } else if (!self && from.x + from.width + STUB * 2 <= to.x) {
    start = { x: from.x + from.width, y: fromY };
    end = { x: to.x, y: toY };
    startDir = 1;
    endDir = -1;
  } else {
    start = { x: from.x + from.width, y: fromY };
    end = { x: to.x + to.width, y: self && fromY === toY ? toY + BOX.row / 2 : toY };
    startDir = 1;
    endDir = 1;
  }
  const a = { x: start.x + startDir * STUB, y: start.y };
  const b = { x: end.x + endDir * STUB, y: end.y };
  let path: string;
  if (startDir === endDir) {
    const out = Math.max(a.x, b.x) + 30;
    path = `M${n(start.x)},${n(start.y)} L${n(a.x)},${n(a.y)} C${n(out)},${n(a.y)} ${n(out)},${n(b.y)} ${n(b.x)},${n(b.y)} L${n(end.x)},${n(end.y)}`;
  } else {
    const pull = Math.max(30, Math.abs(b.x - a.x) / 2);
    path = `M${n(start.x)},${n(start.y)} L${n(a.x)},${n(a.y)} C${n(a.x + startDir * pull)},${n(a.y)} ${n(b.x + endDir * pull)},${n(b.y)} ${n(b.x)},${n(b.y)} L${n(end.x)},${n(end.y)}`;
  }
  // The foot spreads from a point on the line to three points on the box edge.
  const tip = start.x + startDir * 10;
  const many = `M${n(tip)},${n(start.y)} L${n(start.x)},${n(start.y - 6)} M${n(tip)},${n(start.y)} L${n(start.x)},${n(start.y)} M${n(tip)},${n(start.y)} L${n(start.x)},${n(start.y + 6)}`;
  const barX = end.x + endDir * 8;
  const one = `M${n(barX)},${n(end.y - 6)} L${n(barX)},${n(end.y + 6)}`;
  return {
    path,
    many,
    ...(optional ? { optionalRing: { x: start.x + startDir * 15, y: start.y } } : {}),
    one,
  };
}

function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Where everything is, ready to draw. */
export interface DiagramScene {
  readonly boxes: readonly SceneBox[];
  readonly lines: readonly SceneLine[];
  /** The area everything covers. */
  readonly bounds: Box;
}

export interface SceneBox extends Box {
  readonly table: ErDiagramTable;
  readonly text: BoxText;
}

export interface SceneLine extends RelationShape {
  readonly relation: ErDiagramRelation;
}

/** A box measured and its texts shortened, before it has a place. */
export interface MeasuredBox {
  readonly table: ErDiagramTable;
  readonly width: number;
  readonly height: number;
  readonly text: BoxText;
}

/** The slow part (text measuring), done once per table set and detail, not on every drag. */
export function measureBoxes(
  tables: readonly ErDiagramTable[],
  details: ErDetails,
  measure: Measure,
): Map<string, MeasuredBox> {
  const measured = new Map<string, MeasuredBox>();
  for (const table of tables) {
    const size = boxSize(table, details, measure);
    measured.set(table.id, { table, ...size, text: boxText(table, details, size.width, measure) });
  }
  return measured;
}

/** Puts measured boxes where they stand and runs the lines between them. */
export function placeScene(
  measured: ReadonlyMap<string, MeasuredBox>,
  relations: readonly ErDiagramRelation[],
  positions: ReadonlyMap<string, Point>,
  details: ErDetails,
): DiagramScene {
  const boxes = new Map<string, SceneBox>();
  for (const [id, box] of measured) {
    boxes.set(id, { ...box, ...(positions.get(id) ?? { x: 0, y: 0 }) });
  }
  const lines: SceneLine[] = [];
  for (const relation of relations) {
    const from = boxes.get(relation.from);
    const to = boxes.get(relation.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    lines.push({
      relation,
      ...relationShape(
        from,
        rowCenter(from, from.table, relation.columns[0], details),
        to,
        rowCenter(to, to.table, relation.targetColumns[0], details),
        relation.optional,
        relation.from === relation.to,
      ),
    });
  }
  const all = [...boxes.values()];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of all) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    // Room on the right for lines that loop round a box.
    maxX = Math.max(maxX, box.x + box.width + 60);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return {
    boxes: all,
    lines,
    bounds:
      all.length === 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

export function buildScene(
  tables: readonly ErDiagramTable[],
  relations: readonly ErDiagramRelation[],
  positions: ReadonlyMap<string, Point>,
  details: ErDetails,
  measure: Measure,
): DiagramScene {
  return placeScene(measureBoxes(tables, details, measure), relations, positions, details);
}

/** Colours of the exported picture, read from the theme when the page saves. */
export interface DiagramColors {
  readonly background: string;
  readonly box: string;
  readonly header: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly key: string;
  readonly line: string;
  readonly font: string;
}

const MARGIN = 20;

/** The header band of a box: rounded at the top like the box, square where the rows start. */
export function headerPath(x: number, y: number, width: number): string {
  const r = BOX.radius;
  const left = x + 0.5;
  const right = x + width - 0.5;
  const top = y + 0.5;
  const bottom = y + BOX.header;
  return `M${n(left)},${n(bottom)} V${n(top + r)} Q${n(left)},${n(top)} ${n(left + r)},${n(top)} H${n(right - r)} Q${n(right)},${n(top)} ${n(right)},${n(top + r)} V${n(bottom)} Z`;
}

/** A standalone SVG of the scene: fixed colours and no scripts, so any viewer shows it. */
export function sceneToSvg(scene: DiagramScene, colors: DiagramColors): string {
  const { bounds } = scene;
  const width = Math.ceil(bounds.width + MARGIN * 2);
  const height = Math.ceil(bounds.height + MARGIN * 2);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(bounds.x - MARGIN)} ${n(bounds.y - MARGIN)} ${width} ${height}" font-family="${xml(colors.font)}" font-size="12">`,
    `<rect x="${n(bounds.x - MARGIN)}" y="${n(bounds.y - MARGIN)}" width="${width}" height="${height}" fill="${xml(colors.background)}"/>`,
  ];
  for (const line of scene.lines) {
    out.push(
      `<g fill="none" stroke="${xml(colors.line)}" stroke-width="1.3"><path d="${line.path}"/><path d="${line.many}"/><path d="${line.one}"/>${
        line.optionalRing === undefined
          ? ''
          : `<circle cx="${n(line.optionalRing.x)}" cy="${n(line.optionalRing.y)}" r="3.5" fill="${xml(colors.background)}"/>`
      }</g>`,
    );
  }
  for (const box of scene.boxes) {
    const dashed = box.table.external === true ? ' stroke-dasharray="4 3"' : '';
    out.push(
      `<g><rect x="${n(box.x)}" y="${n(box.y)}" width="${box.width}" height="${box.height}" rx="${BOX.radius}" fill="${xml(colors.box)}" stroke="${xml(colors.border)}"${dashed}/>`,
      `<path d="${headerPath(box.x, box.y, box.width)}" fill="${xml(colors.header)}" stroke="${xml(colors.border)}"${dashed}/>`,
      `<text x="${n(box.x + BOX.padding)}" y="${n(box.y + BOX.header / 2 + 4)}" font-weight="bold" fill="${xml(colors.text)}">${xml(box.text.label)}</text>`,
    );
    for (const [index, row] of box.text.rows.entries()) {
      const y = box.y + BOX.header + index * BOX.row + BOX.row / 2 + 4;
      if (row.mark !== '') {
        out.push(
          `<text x="${n(box.x + BOX.padding)}" y="${n(y)}" font-size="9" font-weight="bold" fill="${xml(colors.key)}">${row.mark}</text>`,
        );
      }
      out.push(
        `<text x="${n(box.x + BOX.padding + BOX.icon)}" y="${n(y)}" fill="${xml(colors.text)}">${xml(row.name)}</text>`,
      );
      if (row.type !== '') {
        out.push(
          `<text x="${n(box.x + box.width - BOX.padding)}" y="${n(y)}" text-anchor="end" fill="${xml(colors.muted)}">${xml(row.type)}</text>`,
        );
      }
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}

function xml(text: string): string {
  return (
    text
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      .replace(/"/gu, '&quot;')
      // Characters XML 1.0 cannot hold at all.
      // eslint-disable-next-line no-control-regex -- control characters are what it removes
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
  );
}

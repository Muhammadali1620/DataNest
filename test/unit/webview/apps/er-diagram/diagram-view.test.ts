import { describe, expect, it } from 'vitest';
import type {
  ErDiagramRelation,
  ErDiagramTable,
} from '../../../../../src/shared/protocols/er-diagram';
import {
  BOX,
  boxSize,
  boxText,
  buildScene,
  charMeasure,
  type DiagramColors,
  fit,
  relationShape,
  rowCenter,
  sceneToSvg,
  visibleColumns,
} from '../../../../../webview/src/apps/er-diagram/diagram-view';

const column = (
  name: string,
  dataType = 'int',
  extra: Partial<ErDiagramTable['columns'][number]> = {},
) => ({ name, dataType, nullable: false, primaryKey: false, foreignKey: false, ...extra });

const orders: ErDiagramTable = {
  id: 'orders',
  label: 'orders',
  columns: [
    column('id', 'int', { primaryKey: true }),
    column('customer_id', 'int', { foreignKey: true }),
    column('note', 'text', { nullable: true }),
  ],
};
const customers: ErDiagramTable = {
  id: 'customers',
  label: 'customers',
  columns: [column('id', 'int', { primaryKey: true }), column('name', 'varchar(100)')],
};
const ordersToCustomers: ErDiagramRelation = {
  name: 'fk_customer',
  from: 'orders',
  columns: ['customer_id'],
  to: 'customers',
  targetColumns: ['id'],
  optional: false,
};

const colors: DiagramColors = {
  background: '#fff',
  box: '#eee',
  header: '#ddd',
  border: '#999',
  text: '#111',
  muted: '#777',
  key: '#c80',
  line: '#555',
  font: 'Segoe "UI"',
};

describe('visibleColumns', () => {
  it('lists everything, only keys, or nothing', () => {
    expect(visibleColumns(orders, 'all').map((one) => one.name)).toEqual([
      'id',
      'customer_id',
      'note',
    ]);
    expect(visibleColumns(orders, 'keys').map((one) => one.name)).toEqual(['id', 'customer_id']);
    expect(visibleColumns(orders, 'names')).toEqual([]);
  });

  it('shows every known column of a table elsewhere, even when keys only are asked for', () => {
    const external: ErDiagramTable = {
      id: 'x',
      label: 'promo.coupons',
      external: true,
      columns: [column('code', '')],
    };
    expect(visibleColumns(external, 'keys')).toHaveLength(1);
  });
});

describe('fit', () => {
  it('keeps text that fits and shortens the rest with an ellipsis', () => {
    expect(fit('short', 100, charMeasure)).toBe('short');
    const shortened = fit('a_very_long_column_name', 72, charMeasure);
    expect(shortened.endsWith('…')).toBe(true);
    expect(charMeasure(shortened)).toBeLessThanOrEqual(72);
    expect(charMeasure(`${shortened.slice(0, -1)}x…`)).toBeGreaterThan(72);
  });

  it('gives just the ellipsis when nothing fits', () => {
    expect(fit('abc', 1, charMeasure)).toBe('…');
  });
});

describe('boxSize', () => {
  it('grows with the longest row and the number of rows', () => {
    const size = boxSize(orders, 'all', charMeasure);
    expect(size.height).toBe(BOX.header + 3 * BOX.row + BOX.padding / 2);
    expect(size.width).toBeGreaterThanOrEqual(BOX.minWidth);
    expect(boxSize(orders, 'names', charMeasure).height).toBe(BOX.header);
  });

  it('stays between the smallest and the largest width', () => {
    const tiny: ErDiagramTable = { id: 't', label: 't', columns: [] };
    const wide: ErDiagramTable = {
      id: 'w',
      label: 'w',
      columns: [column('x'.repeat(200), 'varchar(4000)')],
    };
    expect(boxSize(tiny, 'all', charMeasure).width).toBe(BOX.minWidth);
    expect(boxSize(wide, 'all', charMeasure).width).toBe(BOX.maxWidth);
  });
});

describe('boxText', () => {
  it('marks key columns and describes columns in the tooltip', () => {
    const text = boxText(orders, 'all', 300, charMeasure);
    expect(text.rows.map((row) => row.mark)).toEqual(['PK', 'FK', '']);
    expect(text.rows[0]?.title).toBe('id int NOT NULL');
    expect(text.rows[2]?.title).toBe('note text');
  });

  it('drops the type before shortening the name when the box is narrow', () => {
    const wide: ErDiagramTable = {
      id: 'w',
      label: 'w',
      columns: [column('x'.repeat(80), 'varchar(4000)')],
    };
    const text = boxText(wide, 'all', BOX.maxWidth, charMeasure);
    expect(text.rows[0]?.type).toBe('');
    expect(text.rows[0]?.name.endsWith('…')).toBe(true);
  });
});

describe('rowCenter', () => {
  const at = { x: 0, y: 100, width: 200, height: 200 };

  it('finds the row of a shown column', () => {
    expect(rowCenter(at, orders, 'customer_id', 'all')).toBe(
      100 + BOX.header + BOX.row + BOX.row / 2,
    );
  });

  it('falls back to the header for a hidden column', () => {
    expect(rowCenter(at, orders, 'note', 'keys')).toBe(100 + BOX.header / 2);
    expect(rowCenter(at, orders, undefined, 'all')).toBe(100 + BOX.header / 2);
  });
});

describe('relationShape', () => {
  const left = { x: 0, y: 0, width: 100, height: 80 };
  const right = { x: 300, y: 0, width: 100, height: 80 };

  it('joins boxes side by side through the sides that face each other', () => {
    const shape = relationShape(right, 40, left, 20, false, false);
    expect(shape.path.startsWith('M300,40')).toBe(true);
    expect(shape.path.endsWith('L100,20')).toBe(true);
    expect(shape.optionalRing).toBeUndefined();
    const back = relationShape(left, 40, right, 20, true, false);
    expect(back.path.startsWith('M100,40')).toBe(true);
    expect(back.path.endsWith('L300,20')).toBe(true);
    expect(back.optionalRing).toEqual({ x: 115, y: 40 });
  });

  it('goes round the right sides of boxes stacked on top of each other', () => {
    const below = { x: 20, y: 200, width: 100, height: 80 };
    const shape = relationShape(below, 230, left, 20, false, false);
    expect(shape.path.startsWith('M120,230')).toBe(true);
    expect(shape.path.endsWith('L100,20')).toBe(true);
  });

  it('loops a table that points at itself, apart even on the same row', () => {
    const shape = relationShape(left, 40, left, 40, false, true);
    expect(shape.path.startsWith('M100,40')).toBe(true);
    expect(shape.path.endsWith(`L100,${40 + BOX.row / 2}`)).toBe(true);
  });

  it('draws a crow foot at the key and a bar at the referenced table', () => {
    const shape = relationShape(right, 40, left, 20, false, false);
    expect(shape.many.match(/M/gu)).toHaveLength(3);
    expect(shape.one).toBe('M108,14 L108,26');
  });
});

describe('buildScene', () => {
  it('places boxes and lines and measures the whole picture', () => {
    const scene = buildScene(
      [orders, customers],
      [ordersToCustomers],
      new Map([
        ['orders', { x: 400, y: 50 }],
        ['customers', { x: 0, y: 0 }],
      ]),
      'all',
      charMeasure,
    );
    expect(scene.boxes.map((one) => [one.table.id, one.x, one.y])).toEqual([
      ['orders', 400, 50],
      ['customers', 0, 0],
    ]);
    expect(scene.lines).toHaveLength(1);
    expect(scene.bounds.x).toBe(0);
    expect(scene.bounds.width).toBeGreaterThan(400);
  });

  it('skips relations to tables that are not drawn', () => {
    const scene = buildScene([orders], [ordersToCustomers], new Map(), 'all', charMeasure);
    expect(scene.lines).toEqual([]);
  });

  it('has an empty area for an empty diagram', () => {
    expect(buildScene([], [], new Map(), 'all', charMeasure).bounds).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('sceneToSvg', () => {
  const scene = buildScene(
    [orders, { ...customers, label: 'a<b>&"c"\u0001', external: true }],
    [ordersToCustomers],
    new Map([
      ['orders', { x: 300, y: 0 }],
      ['customers', { x: 0, y: 0 }],
    ]),
    'all',
    charMeasure,
  );
  const svg = sceneToSvg(scene, colors);

  it('writes a standalone SVG with its size and the theme colours', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    expect(svg).toMatch(/width="\d+" height="\d+"/u);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('font-family="Segoe &quot;UI&quot;"');
    expect(svg).not.toContain('var(--');
  });

  it('escapes names and drops characters XML cannot hold', () => {
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c&quot;</text>');
    expect(svg).not.toContain('\u0001');
  });

  it('dashes the border of a table elsewhere and marks keys', () => {
    expect(svg).toContain('stroke-dasharray="4 3"');
    expect(svg).toContain('>PK</text>');
    expect(svg).toContain('>FK</text>');
    expect(svg).toContain(scene.lines[0]?.path ?? 'missing');
  });

  it('parses as XML', () => {
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(document.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(document.documentElement.getAttribute('viewBox')).toMatch(/^-20 -20 /u);
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  erDiagramProtocol,
  type ErDiagramProtocol,
  type ErDiagramState,
  type ErPosition,
} from '../../../../../src/shared/protocols/er-diagram';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/er-diagram/App.svelte';
import type { DiagramColors } from '../../../../../webview/src/apps/er-diagram/diagram-view';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';
import { chooseFromMenu, menuLabels } from '../../../../helpers/webview/menu';

type HostPeer = RpcPeer<ErDiagramProtocol['host'], ErDiagramProtocol['webview']>;

const column = (name: string, extra: { primaryKey?: boolean; foreignKey?: boolean } = {}) => ({
  name,
  dataType: 'int',
  nullable: false,
  primaryKey: extra.primaryKey ?? false,
  foreignKey: extra.foreignKey ?? false,
});

function state(overrides: Partial<ErDiagramState> = {}): ErDiagramState {
  return {
    scope: 'shop',
    connection: 'Local',
    tables: [
      { id: 'customers', label: 'customers', columns: [column('id', { primaryKey: true })] },
      {
        id: 'orders',
        label: 'orders',
        columns: [
          column('id', { primaryKey: true }),
          column('customer_id', { foreignKey: true }),
          column('total'),
        ],
      },
      { id: 'ext', label: 'promo.coupons', columns: [column('id')], external: true },
    ],
    relations: [
      {
        name: 'orders_customer',
        from: 'orders',
        columns: ['customer_id'],
        to: 'customers',
        targetColumns: ['id'],
        optional: false,
      },
    ],
    positions: [],
    details: 'all',
    ...overrides,
  };
}

const colors = (): DiagramColors => ({
  background: '#fff',
  box: '#eee',
  header: '#ddd',
  border: '#999',
  text: '#111',
  muted: '#777',
  key: '#c80',
  line: '#555',
  font: 'sans-serif',
});

async function setup(options: { initial?: ErDiagramState | null } = {}) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: erDiagramProtocol.host,
    remote: erDiagramProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: erDiagramProtocol.webview,
    remote: erDiagramProtocol.host,
    transport: transports.webview,
  });
  const positions: ErPosition[][] = [];
  const saves: { format: string; data: string }[] = [];
  const events = {
    ready: vi.fn(),
    refresh: vi.fn(),
    openTable: vi.fn(),
    details: vi.fn(),
    tableNav: vi.fn(),
  };
  host.on('ready', events.ready);
  host.on('refresh', events.refresh);
  host.on('openTable', events.openTable);
  host.on('details', events.details);
  host.on('tableNav', events.tableNav);
  host.on('positions', (event) => positions.push(event.positions));
  host.handle('save', (request) => {
    saves.push(request);
    return { saved: true };
  });
  const toPng = vi.fn((_svg: string, _width: number, _height: number) =>
    Promise.resolve('iVBORw0KGgo='),
  );
  render(App, { props: { rpc, t: createTranslator('en'), toPng, colors } });
  await flush();
  if (options.initial !== null) {
    host.emit('state', options.initial ?? state());
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ER diagram of shop');
    });
  }
  return { host, positions, saves, events, toPng };
}

const boxOf = (id: string): SVGGElement => {
  const found = document.querySelector<SVGGElement>(`[data-table="${id}"]`);
  if (found === null) {
    throw new Error(`no box for ${id}`);
  }
  return found;
};

describe('ER diagram page', () => {
  it('asks for the state, then shows progress while the host reads', async () => {
    const page = await setup({ initial: null });
    expect(page.events.ready).toHaveBeenCalled();
    page.host.emit('loading', { done: 3, total: 10 });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Reading the tables: 3 of 10');
    });
  });

  it('draws a box per table with its columns and a line per key', async () => {
    await setup();
    expect(screen.getByText('Tables: 3, keys: 1')).not.toBeNull();
    expect(boxOf('orders').textContent).toContain('customer_id');
    // Key marks are icons; which key a mark stands for is in its data, not in colour alone.
    const marks = [...boxOf('orders').querySelectorAll('[data-mark]')].map((mark) =>
      mark.getAttribute('data-mark'),
    );
    expect(marks).toEqual(['PK', 'FK']);
    expect(boxOf('orders').querySelector('[data-mark="PK"]')?.classList.contains('primary')).toBe(
      true,
    );
    expect(screen.getByText('primary key')).not.toBeNull();
    expect(screen.getByText('foreign key')).not.toBeNull();
    expect(boxOf('ext').classList.contains('external')).toBe(true);
    expect(document.querySelectorAll('g.line')).toHaveLength(1);
  });

  it('lays the boxes out itself when the host has no places, and reports them', async () => {
    const page = await setup();
    await waitFor(() => {
      expect(page.positions).toHaveLength(1);
    });
    const placed = new Map(page.positions[0]?.map((at) => [at.id, at]));
    expect(placed.size).toBe(3);
    expect(placed.get('customers')?.x).toBeLessThan(placed.get('orders')?.x ?? 0);
  });

  it('keeps the places the host remembers', async () => {
    const page = await setup({
      initial: state({
        positions: [
          { id: 'customers', x: 500, y: 10 },
          { id: 'orders', x: 0, y: 0 },
          { id: 'ext', x: 0, y: 400 },
        ],
      }),
    });
    expect(boxOf('customers').getAttribute('transform')).toBe('translate(500 10)');
    await flush();
    expect(page.positions).toEqual([]);
  });

  it('moves a dragged box and reports the new place', async () => {
    const page = await setup({
      initial: state({
        positions: [
          { id: 'customers', x: 0, y: 0 },
          { id: 'orders', x: 300, y: 0 },
          { id: 'ext', x: 0, y: 300 },
        ],
      }),
    });
    await fireEvent.pointerDown(boxOf('orders'), { button: 0, clientX: 10, clientY: 10 });
    await fireEvent.pointerMove(window, { clientX: 60, clientY: 30 });
    await fireEvent.pointerUp(window);
    expect(boxOf('orders').getAttribute('transform')).toBe('translate(350 20)');
    await waitFor(() => {
      expect(page.positions.at(-1)).toEqual([{ id: 'orders', x: 350, y: 20 }]);
    });
  });

  it('treats a press without movement as a click that highlights the keys of a table', async () => {
    const page = await setup();
    await fireEvent.pointerDown(boxOf('customers'), { button: 0, clientX: 10, clientY: 10 });
    await fireEvent.pointerUp(window);
    expect(boxOf('customers').classList.contains('selected')).toBe(true);
    expect(boxOf('orders').classList.contains('faded')).toBe(false);
    expect(boxOf('ext').classList.contains('faded')).toBe(true);
    expect(document.querySelector('g.line')?.classList.contains('lit')).toBe(true);
    expect(page.positions).toHaveLength(1);
  });

  it('opens the rows of a table on a double click, but not of a table elsewhere', async () => {
    const page = await setup();
    await fireEvent.dblClick(boxOf('orders'));
    await fireEvent.dblClick(boxOf('ext'));
    await waitFor(() => {
      expect(page.events.openTable).toHaveBeenCalledTimes(1);
    });
    expect(page.events.openTable).toHaveBeenCalledWith({ id: 'orders' });
  });

  it('shows fewer columns for keys only or names only, and tells the host', async () => {
    const page = await setup();
    const select = screen.getByLabelText<HTMLSelectElement>('Show');
    await fireEvent.change(select, { target: { value: 'keys' } });
    expect(boxOf('orders').textContent).not.toContain('total');
    await fireEvent.change(select, { target: { value: 'names' } });
    expect(boxOf('orders').textContent).not.toContain('customer_id');
    await waitFor(() => {
      expect(page.events.details).toHaveBeenLastCalledWith({ details: 'names' });
    });
  });

  it('highlights tables that match the search and picks them one by one', async () => {
    await setup();
    const search = screen.getByLabelText('Find a table');
    await fireEvent.input(search, { target: { value: 'ORD' } });
    expect(boxOf('orders').classList.contains('match')).toBe(true);
    expect(boxOf('customers').classList.contains('match')).toBe(false);
    expect(screen.getByTestId('er-hits').textContent.trim()).toBe('Found: 1');
    await fireEvent.keyDown(search, { key: 'Enter' });
    expect(boxOf('orders').classList.contains('selected')).toBe(true);
    await fireEvent.input(search, { target: { value: 'invoices' } });
    expect(screen.getByTestId('er-hits').textContent.trim()).toBe('No such table');
    expect(document.querySelector('g.box.match')).toBeNull();
  });

  it('zooms with the buttons and the keyboard', async () => {
    await setup();
    const reset = screen.getByTitle('Actual size');
    const before = reset.textContent;
    await fireEvent.click(screen.getByTitle('Zoom in (+)'));
    expect(reset.textContent).not.toBe(before);
    await fireEvent.click(reset);
    expect(reset.textContent).toBe('100%');
    await fireEvent.keyDown(screen.getByRole('application'), { key: '-' });
    expect(reset.textContent).toBe('83%');
  });

  it('fits a wide picture into the window once the window has a size', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    try {
      await setup();
      const zoom = Number.parseInt(screen.getByTitle('Actual size').textContent, 10);
      expect(zoom).toBeLessThan(100);
      expect(zoom).toBeGreaterThan(0);
      await fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
      expect(Number.parseInt(screen.getByTitle('Actual size').textContent, 10)).toBe(zoom);
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('pans with the wheel and zooms with Ctrl+wheel', async () => {
    await setup();
    const canvas = screen.getByRole('application');
    const group = (): string => canvas.querySelector('svg > g')?.getAttribute('transform') ?? '';
    const before = group();
    await fireEvent.wheel(canvas, { deltaX: 0, deltaY: 50 });
    expect(group()).not.toBe(before);
    expect(screen.getByTitle('Actual size').textContent).toBe('100%');
    await fireEvent.wheel(canvas, { deltaY: -300, ctrlKey: true });
    expect(screen.getByTitle('Actual size').textContent).not.toBe('100%');
  });

  describe('with the keyboard (V9.3)', () => {
    const canvas = (): HTMLElement => screen.getByRole('application');
    const transform = (): string =>
      canvas().querySelector('svg > g')?.getAttribute('transform') ?? '';
    const announced = (): string => screen.getByTestId('er-announce').textContent.trim();

    it('pans with the arrow keys, further with Shift', async () => {
      await setup();
      const start = transform();
      await fireEvent.keyDown(canvas(), { key: 'ArrowRight' });
      const right = transform();
      expect(right).not.toBe(start);
      await fireEvent.keyDown(canvas(), { key: 'ArrowLeft' });
      expect(transform()).toBe(start);
      await fireEvent.keyDown(canvas(), { key: 'ArrowDown', shiftKey: true });
      const [, , before] = /translate\(([-\d.]+) ([-\d.]+)\)/u.exec(start) ?? [];
      const [, , after] = /translate\(([-\d.]+) ([-\d.]+)\)/u.exec(transform()) ?? [];
      expect(Number(before) - Number(after)).toBe(200);
    });

    it('walks the tables by name with ] and [, round the ends, and says which one', async () => {
      await setup();
      expect(announced()).toBe('');
      await fireEvent.keyDown(canvas(), { key: ']' });
      expect(boxOf('customers').classList.contains('selected')).toBe(true);
      expect(announced()).toBe('Table customers: 1 columns, 0 foreign keys, referenced by 1');
      await fireEvent.keyDown(canvas(), { key: 'n' });
      expect(boxOf('orders').classList.contains('selected')).toBe(true);
      expect(announced()).toBe('Table orders: 3 columns, 1 foreign keys, referenced by 0');
      await fireEvent.keyDown(canvas(), { key: ']' });
      expect(boxOf('ext').classList.contains('selected')).toBe(true);
      await fireEvent.keyDown(canvas(), { key: ']' });
      expect(boxOf('customers').classList.contains('selected')).toBe(true);
      await fireEvent.keyDown(canvas(), { key: '[' });
      expect(boxOf('ext').classList.contains('selected')).toBe(true);
      await fireEvent.keyDown(canvas(), { key: 'p' });
      expect(boxOf('orders').classList.contains('selected')).toBe(true);
    });

    it('starts from the last table when walking backwards with nothing selected', async () => {
      await setup();
      await fireEvent.keyDown(canvas(), { key: '[' });
      expect(boxOf('ext').classList.contains('selected')).toBe(true);
    });

    it('centres the table it moves to', async () => {
      await setup();
      const start = transform();
      await fireEvent.keyDown(canvas(), { key: ']' });
      expect(transform()).not.toBe(start);
    });

    it('opens the selected table with Enter and clears the choice with Esc', async () => {
      const page = await setup();
      await fireEvent.keyDown(canvas(), { key: ']' });
      await fireEvent.keyDown(canvas(), { key: 'Enter' });
      await waitFor(() => {
        expect(page.events.openTable).toHaveBeenCalledWith({ id: 'customers' });
      });
      await fireEvent.keyDown(canvas(), { key: 'Escape' });
      expect(boxOf('customers').classList.contains('selected')).toBe(false);
      expect(announced()).toBe('');
    });

    it('describes its keys and names the zoom buttons', async () => {
      await setup();
      const help = document.getElementById(canvas().getAttribute('aria-describedby') ?? '');
      expect(help?.textContent).toContain('] and [');
      // The same help is the tooltip of the question mark in the status bar.
      expect(help?.parentElement?.getAttribute('title')).toContain('double click opens its rows');
      expect(screen.getByRole('button', { name: 'Zoom in (+)' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Zoom out (-)' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Actual size: 100%' })).toBeTruthy();
    });

    it('leaves keys typed into the search box alone', async () => {
      await setup();
      const search = screen.getByLabelText('Find a table');
      const start = transform();
      await fireEvent.keyDown(search, { key: 'ArrowRight' });
      await fireEvent.keyDown(search, { key: ']' });
      expect(transform()).toBe(start);
      expect(document.querySelector('g.box.selected')).toBeNull();
    });
  });

  it('pans when the background is dragged', async () => {
    await setup();
    const canvas = screen.getByRole('application');
    const group = (): string => canvas.querySelector('svg > g')?.getAttribute('transform') ?? '';
    const before = group();
    await fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 });
    await fireEvent.pointerMove(window, { clientX: 140, clientY: 90 });
    await fireEvent.pointerUp(window);
    expect(group()).not.toBe(before);
  });

  it('asks the host to read the tables again', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(page.events.refresh).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true);
  });

  it('offers the picture formats in one menu', async () => {
    await setup();
    expect(await menuLabels('er-export')).toEqual(['Save SVG', 'Save PNG']);
  });

  it('saves an SVG with the theme colours', async () => {
    const page = await setup();
    await chooseFromMenu('er-export', 'Save SVG');
    await waitFor(() => {
      expect(page.saves).toHaveLength(1);
    });
    expect(page.saves[0]?.format).toBe('svg');
    expect(page.saves[0]?.data).toContain('<svg');
    expect(page.saves[0]?.data).toContain('fill="#fff"');
  });

  it('saves a PNG drawn from the SVG at its size', async () => {
    const page = await setup();
    await chooseFromMenu('er-export', 'Save PNG');
    await waitFor(() => {
      expect(page.saves).toEqual([{ format: 'png', data: 'iVBORw0KGgo=' }]);
    });
    const [svg, width, height] = page.toPng.mock.calls[0] ?? [];
    expect(svg).toContain('<svg');
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('shows why a picture could not be made', async () => {
    const page = await setup();
    page.toPng.mockRejectedValueOnce(new Error('The diagram could not be drawn as a picture'));
    await chooseFromMenu('er-export', 'Save PNG');
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        'The diagram could not be drawn as a picture',
      );
    });
    expect(page.saves).toEqual([]);
  });

  it('shows why reading failed', async () => {
    const page = await setup({ initial: null });
    page.host.emit('failed', { message: 'permission denied for schema shop' });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('permission denied for schema shop');
    });
  });

  it('reads again from the failure when asked to try again', async () => {
    const page = await setup({ initial: null });
    page.host.emit('failed', { message: 'connection reset' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(page.events.refresh).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Reading the tables…');
  });

  it('shows the progress of a refresh under the diagram it keeps', async () => {
    const page = await setup();
    page.host.emit('loading', { done: 2, total: 5 });
    await waitFor(() => {
      expect(screen.getByRole('progressbar')).not.toBeNull();
    });
    expect(screen.getByText('Reading the tables: 2 of 5')).not.toBeNull();
    expect(boxOf('orders')).not.toBeNull();
  });

  it('says so when there are no tables', async () => {
    await setup({ initial: state({ tables: [], relations: [] }) });
    expect(screen.getByText('There are no tables here')).not.toBeNull();
    expect(screen.queryByRole('application')).toBeNull();
    // Nothing to zoom or save, but the tables can be read again.
    expect(screen.queryByRole('button', { name: 'Zoom in (+)' })).toBeNull();
    expect(screen.queryByTestId('er-export')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeNull();
  });

  it('forgets a selected table that is gone after a refresh', async () => {
    const page = await setup();
    await fireEvent.pointerDown(boxOf('customers'), { button: 0, clientX: 1, clientY: 1 });
    await fireEvent.pointerUp(window);
    const next = state();
    page.host.emit('state', {
      ...next,
      tables: next.tables.filter((table) => table.id !== 'customers'),
      relations: [],
    });
    await waitFor(() => {
      expect(document.querySelector('[data-table="customers"]')).toBeNull();
    });
    expect(boxOf('orders').classList.contains('faded')).toBe(false);
  });
});

describe('opened from a table', () => {
  const sized = () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    return () => {
      width.mockRestore();
      height.mockRestore();
    };
  };

  const placed = [
    { id: 'customers', x: 5000, y: 3000 },
    { id: 'orders', x: 0, y: 0 },
    { id: 'ext', x: 0, y: 400 },
  ];

  /** Where the group of boxes is drawn: the camera of the page. */
  const camera = (): string =>
    document.querySelector('svg g[transform^="translate("]')?.getAttribute('transform') ?? '';

  it('draws every table, selects that one and stands over it at actual size', async () => {
    const restore = sized();
    try {
      await setup({ initial: state({ focus: 'customers', positions: placed }) });
      expect(document.querySelectorAll('[data-table]')).toHaveLength(3);
      expect(boxOf('customers').classList.contains('selected')).toBe(true);
      expect(screen.getByTitle('Actual size').textContent).toBe('100%');
      // The far box is in the middle of the 800 × 600 canvas, not off screen.
      const found = /translate\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)/u.exec(camera());
      expect(found).not.toBeNull();
      const [x, y] = (found ?? []).slice(1).map(Number);
      expect(x).toBeLessThan(-4000);
      expect(y).toBeLessThan(-2000);
    } finally {
      restore();
    }
  });

  it('waits for the canvas to have a size before it moves the camera', async () => {
    await setup({ initial: state({ focus: 'customers', positions: placed }) });
    expect(boxOf('customers').classList.contains('selected')).toBe(false);
    const restore = sized();
    try {
      window.dispatchEvent(new Event('resize'));
      await flush();
      expect(boxOf('customers').classList.contains('selected')).toBe(true);
    } finally {
      restore();
    }
  });

  it('ignores a table the diagram does not have', async () => {
    const restore = sized();
    try {
      await setup({ initial: state({ focus: 'gone', positions: placed }) });
      expect(document.querySelector('[data-table].selected')).toBeNull();
    } finally {
      restore();
    }
  });

  it('moves the camera when the host shows the open diagram again from another table', async () => {
    const restore = sized();
    try {
      const page = await setup({ initial: state({ focus: 'customers', positions: placed }) });
      page.host.emit('focus', { id: 'orders' });
      await flush();
      expect(boxOf('orders').classList.contains('selected')).toBe(true);
      expect(boxOf('customers').classList.contains('selected')).toBe(false);
    } finally {
      restore();
    }
  });

  it('has the bar of the table with its own page lit, and none without a table', async () => {
    const page = await setup({ initial: state({ focus: 'orders', tableBar: { isView: false } }) });
    expect(screen.getByTestId('table-tab-er').getAttribute('aria-current')).toBe('page');
    await fireEvent.click(screen.getByTestId('table-tab-properties'));
    await waitFor(() => {
      expect(page.events.tableNav).toHaveBeenCalledWith({ action: 'properties', dirty: false });
    });
    cleanup();
    await setup();
    expect(screen.queryByTestId('table-bar')).toBeNull();
  });
});

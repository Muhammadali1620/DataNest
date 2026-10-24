import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultGridState,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { MIN_COLUMN_WIDTH } from '../../../../../webview/src/apps/result-grid/columns';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

function tab(overrides: Partial<ResultTab> = {}): ResultTab {
  return {
    id: 'result-1',
    title: 'SELECT 1',
    statement: 'SELECT 1',
    columns: [{ name: 'id', dataType: 'int' }, { name: 'email' }],
    rowCount: 2,
    truncated: false,
    durationMs: 7,
    ...overrides,
  };
}

function setup(lang = 'en') {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: resultGridProtocol.host,
    remote: resultGridProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: resultGridProtocol.webview,
    remote: resultGridProtocol.host,
    transport: transports.webview,
  });
  const ready = vi.fn();
  const selected = vi.fn();
  const cancelled = vi.fn();
  const copied = vi.fn();
  const revealed = vi.fn();
  host.on('ready', ready);
  host.on('selectTab', selected);
  host.on('cancel', cancelled);
  host.on('copyText', copied);
  host.on('revealError', revealed);
  const view = render(App, { props: { rpc, t: createTranslator(lang) } });
  return { host, rpc, ready, selected, cancelled, copied, revealed, view };
}

const ROWS = [
  [1, 'alice@example.com'],
  [2, null],
];

/** Serves windows the way the host does: only the rows that were asked for. */
function serveRows(host: HostPeer, rows = ROWS): ReturnType<typeof vi.fn> {
  const handler = vi.fn(
    ({ resultId, offset, limit }: { resultId: string; offset: number; limit: number }) => ({
      resultId,
      offset,
      rows: rows.slice(offset, offset + limit),
      rowCount: rows.length,
    }),
  );
  host.handle('rows', handler);
  return handler;
}

async function withState(state: ResultGridState, lang = 'en') {
  const harness = setup(lang);
  const handler = serveRows(harness.host);
  await flush();
  harness.host.emit('state', state);
  // The page renders the state asynchronously; every test starts after that.
  // ("Loading…" is no good as a signal: a row awaiting its cells says the same.)
  if (state.tabs.length > 0) {
    await waitFor(() => {
      expect(screen.queryByRole('tablist')).not.toBeNull();
    });
  }
  return { ...harness, handler };
}

/** Row-number plus cell texts of every data row, in order. */
function cellTexts(): string[][] {
  return screen
    .getAllByRole('row')
    .filter((row) => row.querySelector('[role="gridcell"]') !== null)
    .map((row) =>
      [...row.querySelectorAll('[role="rowheader"], [role="gridcell"]')].map((cell) =>
        cell.textContent.trim(),
      ),
    );
}

function headerTexts(): string[] {
  return screen.getAllByRole('columnheader').map((cell) => cell.textContent.trim());
}

describe('result grid App', () => {
  it('tells the host it is ready and waits for state', async () => {
    const { ready } = setup();
    await flush();
    expect(ready).toHaveBeenCalledOnce();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('invites the user to run a query when there are no results', async () => {
    await withState({ tabs: [], running: false });
    await waitFor(() => {
      expect(screen.getByText('Run a query to see results here')).toBeTruthy();
    });
  });

  it('says it is running when a statement is in flight with no result yet', async () => {
    await withState({ tabs: [], running: true });
    await waitFor(() => {
      expect(screen.getByText('Running…')).toBeTruthy();
    });
  });

  it('shows the rows of the active result', async () => {
    const { handler } = await withState({ tabs: [tab()], activeId: 'result-1', running: false });
    await waitFor(() => {
      expect(screen.getByTestId('grid')).toBeTruthy();
    });
    // The window never exceeds the result: two rows means a limit of two.
    expect(handler).toHaveBeenCalledWith({ resultId: 'result-1', offset: 0, limit: 2 });
    await waitFor(() => {
      expect(cellTexts()).toEqual([
        ['1', '1', 'alice@example.com'],
        ['2', '2', 'NULL'],
      ]);
    });
  });

  it('shows the column names in order, after the row-number column', async () => {
    await withState({ tabs: [tab()], activeId: 'result-1', running: false });
    await waitFor(() => {
      expect(headerTexts()).toEqual(['#', 'id', 'email']);
    });
  });

  it('numbers the rows from one', async () => {
    await withState({ tabs: [tab()], activeId: 'result-1', running: false });
    await waitFor(() => {
      expect(cellTexts().map((row) => row[0])).toEqual(['1', '2']);
    });
  });

  it('summarizes the row count and the time', async () => {
    await withState({ tabs: [tab()], activeId: 'result-1', running: false });
    await waitFor(() => {
      expect(screen.getByTestId('summary').textContent).toContain('2 rows · 7 ms');
    });
  });

  it('summarizes affected rows for a write', async () => {
    await withState({
      tabs: [tab({ affectedRows: 5, rowCount: 0, columns: [] })],
      activeId: 'result-1',
      running: false,
    });
    await waitFor(() => {
      expect(screen.getByTestId('summary').textContent).toContain('5 rows affected · 7 ms');
    });
  });

  it('warns when the row limit cut the result', async () => {
    await withState({ tabs: [tab({ truncated: true })], activeId: 'result-1', running: false });
    await waitFor(() => {
      expect(screen.getByTestId('summary').textContent).toContain('the row limit cut this result');
    });
  });

  it('shows the error of a failed statement and asks for no rows', async () => {
    const { handler } = await withState({
      tabs: [tab({ error: { code: 'syntax', message: 'near "SELEC"' }, rowCount: 0 })],
      activeId: 'result-1',
      running: false,
    });
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('near "SELEC"');
    });
    expect(handler).not.toHaveBeenCalled();
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  describe('tabs', () => {
    const two = {
      tabs: [tab(), tab({ id: 'result-2', title: 'SELECT 2', statement: 'SELECT 2' })],
      activeId: 'result-2',
      running: false,
    } satisfies ResultGridState;

    it('shows one tab per result and marks the active one', async () => {
      await withState(two);
      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(2);
      });
      const active = screen.getAllByRole('tab').filter((item) => item.ariaSelected === 'true');
      expect(active).toHaveLength(1);
      expect(active[0]?.textContent.trim()).toBe('SELECT 2');
    });

    it('tells the host when the user switches tab, and loads its rows', async () => {
      const { selected, handler } = await withState(two);
      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(2);
      });
      handler.mockClear();
      await fireEvent.click(screen.getByRole('tab', { name: 'SELECT 1' }));
      await waitFor(() => {
        expect(selected).toHaveBeenCalledWith({ resultId: 'result-1' });
      });
      expect(handler).toHaveBeenCalledWith({ resultId: 'result-1', offset: 0, limit: 2 });
    });

    it('does nothing when the active tab is clicked again', async () => {
      const { selected } = await withState(two);
      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(2);
      });
      await fireEvent.click(screen.getByRole('tab', { name: 'SELECT 2' }));
      await flush();
      expect(selected).not.toHaveBeenCalled();
    });

    it('offers a cancel button only while running', async () => {
      const { host } = await withState({ ...two, running: true });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      });
      host.emit('state', { ...two, running: false });
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      });
    });

    it('asks the host to cancel when the button is pressed', async () => {
      const { cancelled } = await withState({ ...two, running: true });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(cancelled).toHaveBeenCalledOnce();
      });
    });
  });

  it('reports a failure to load rows', async () => {
    const harness = setup();
    harness.host.handle('rows', () => {
      throw new Error('The result is gone');
    });
    await flush();
    harness.host.emit('state', { tabs: [tab()], activeId: 'result-1', running: false });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('The result is gone');
    });
  });

  it('renders row text as text, never as HTML', async () => {
    const harness = setup();
    serveRows(harness.host, [[1, '<img src=x onerror=alert(1)>']]);
    await flush();
    harness.host.emit('state', {
      tabs: [tab({ rowCount: 1 })],
      activeId: 'result-1',
      running: false,
    });
    await waitFor(() => {
      expect(cellTexts()).toEqual([['1', '1', '<img src=x onerror=alert(1)>']]);
    });
    expect(document.querySelector('img')).toBeNull();
  });

  it('asks for a window around the visible rows when the result is large', async () => {
    const harness = setup();
    const handler = vi.fn(
      ({ resultId, offset }: { resultId: string; offset: number; limit: number }) => ({
        resultId,
        offset,
        rows: ROWS,
        rowCount: 10_000,
      }),
    );
    harness.host.handle('rows', handler);
    await flush();
    harness.host.emit('state', {
      tabs: [tab({ rowCount: 10_000 })],
      activeId: 'result-1',
      running: false,
    });
    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
    const asked = handler.mock.calls[0]?.[0];
    expect(asked?.offset).toBe(0);
    // Enough for the viewport and its overscan, and never a whole result.
    expect(asked?.limit).toBeGreaterThanOrEqual(20);
    expect(asked?.limit).toBeLessThan(10_000);
  });

  it('uses the page language', async () => {
    await withState({ tabs: [], running: false }, 'ru');
    await waitFor(() => {
      expect(screen.getByText('Выполните запрос, чтобы увидеть результат')).toBeTruthy();
    });
  });

  describe('virtualization', () => {
    it('renders only a window of rows for a huge result', async () => {
      const harness = setup();
      harness.host.handle('rows', ({ resultId, offset, limit }) => ({
        resultId,
        offset,
        rows: Array.from({ length: limit }, (_, index) => [offset + index, 'x']),
        rowCount: 100_000,
      }));
      await flush();
      harness.host.emit('state', {
        tabs: [tab({ rowCount: 100_000 })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(cellTexts().length).toBeGreaterThan(0);
      });
      // A hundred thousand rows must never all be in the DOM.
      expect(cellTexts().length).toBeLessThan(100);
    });

    it('sizes the scroll canvas for the whole result', async () => {
      const harness = setup();
      serveRows(harness.host);
      await flush();
      harness.host.emit('state', {
        tabs: [tab({ rowCount: 1000 })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('grid').querySelector('.canvas')).not.toBeNull();
      });
      const canvas = screen.getByTestId('grid').querySelector('.canvas');
      // 1000 rows at 22px each; the scrollbar must match the result, not the DOM.
      expect(canvas?.getAttribute('style')).toContain('height: 22000px');
    });

    it('exposes the row and column counts for assistive technology', async () => {
      await withState({ tabs: [tab({ rowCount: 500 })], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getByTestId('grid').getAttribute('aria-rowcount')).toBe('500');
      });
      expect(screen.getByTestId('grid').getAttribute('aria-colcount')).toBe('2');
    });
  });

  describe('column resize', () => {
    it('offers a separator per column', async () => {
      await withState({ tabs: [tab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getAllByRole('separator')).toHaveLength(2);
      });
      expect(screen.getByRole('separator', { name: 'Resize column id' })).toBeTruthy();
    });

    it('changes the column width while the pointer moves', async () => {
      await withState({ tabs: [tab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getAllByRole('separator')).toHaveLength(2);
      });
      const header = screen.getAllByRole('columnheader')[1];
      const grip = screen.getByRole('separator', { name: 'Resize column id' });
      const before = header?.getAttribute('style') ?? '';
      await fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1 });
      await fireEvent.pointerMove(grip, { clientX: 180, pointerId: 1 });
      await waitFor(() => {
        expect(header?.getAttribute('style')).not.toBe(before);
      });
      const width = Number(/width: (\d+)px/.exec(header?.getAttribute('style') ?? '')?.[1]);
      expect(width).toBeGreaterThan(80);
      await fireEvent.pointerUp(grip, { pointerId: 1 });
    });

    it('never narrows a column below the minimum', async () => {
      await withState({ tabs: [tab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getAllByRole('separator')).toHaveLength(2);
      });
      const header = screen.getAllByRole('columnheader')[1];
      const grip = screen.getByRole('separator', { name: 'Resize column id' });
      await fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1 });
      await fireEvent.pointerMove(grip, { clientX: -5000, pointerId: 1 });
      await waitFor(() => {
        expect(header?.getAttribute('style')).toContain(`width: ${MIN_COLUMN_WIDTH}px`);
      });
      await fireEvent.pointerUp(grip, { pointerId: 1 });
    });

    it('stops following the pointer after the drag ends', async () => {
      await withState({ tabs: [tab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getAllByRole('separator')).toHaveLength(2);
      });
      const header = screen.getAllByRole('columnheader')[1];
      const grip = screen.getByRole('separator', { name: 'Resize column id' });
      await fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1 });
      await fireEvent.pointerMove(grip, { clientX: 150, pointerId: 1 });
      await fireEvent.pointerUp(grip, { pointerId: 1 });
      const settled = header?.getAttribute('style');
      await fireEvent.pointerMove(grip, { clientX: 400, pointerId: 1 });
      expect(header?.getAttribute('style')).toBe(settled);
    });
  });

  describe('selection and copy', () => {
    async function grid() {
      const harness = await withState({
        tabs: [tab()],
        activeId: 'result-1',
        running: false,
      });
      // A row whose cells have not arrived renders one placeholder cell, so the
      // wait is for cells that carry a column index.
      await waitFor(() => {
        expect(
          screen
            .getAllByRole('gridcell')
            .filter((item) => item.getAttribute('aria-colindex') !== null).length,
        ).toBeGreaterThan(0);
      });
      return harness;
    }

    function cell(row: number, column: number): HTMLElement {
      const cells = screen
        .getAllByRole('gridcell')
        .filter((item) => item.getAttribute('aria-colindex') === String(column + 1));
      const found = cells[row];
      if (found === undefined) {
        throw new Error(`no cell at row ${row}, column ${column}`);
      }
      return found;
    }

    it('selects a cell on click', async () => {
      await grid();
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await waitFor(() => {
        expect(cell(0, 0).getAttribute('aria-selected')).toBe('true');
      });
      expect(cell(0, 1).getAttribute('aria-selected')).toBe('false');
    });

    it('extends the selection by dragging over cells', async () => {
      await grid();
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await fireEvent.pointerEnter(cell(1, 1));
      await waitFor(() => {
        expect(cell(1, 1).getAttribute('aria-selected')).toBe('true');
      });
      expect(cell(0, 1).getAttribute('aria-selected')).toBe('true');
      expect(cell(1, 0).getAttribute('aria-selected')).toBe('true');
    });

    it('stops extending once the pointer is up', async () => {
      await grid();
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await fireEvent.pointerUp(screen.getByTestId('grid'));
      await fireEvent.pointerEnter(cell(1, 1));
      await waitFor(() => {
        expect(cell(0, 0).getAttribute('aria-selected')).toBe('true');
      });
      expect(cell(1, 1).getAttribute('aria-selected')).toBe('false');
    });

    it('extends with shift+click', async () => {
      await grid();
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await fireEvent.pointerUp(screen.getByTestId('grid'));
      await fireEvent.pointerDown(cell(1, 1), { button: 0, shiftKey: true });
      await waitFor(() => {
        expect(cell(0, 1).getAttribute('aria-selected')).toBe('true');
      });
    });

    it('moves the selection with the arrow keys', async () => {
      await grid();
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'ArrowRight' });
      await waitFor(() => {
        expect(cell(0, 1).getAttribute('aria-selected')).toBe('true');
      });
      expect(cell(0, 0).getAttribute('aria-selected')).toBe('false');
    });

    it('extends with shift and an arrow key', async () => {
      await grid();
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'ArrowDown', shiftKey: true });
      await waitFor(() => {
        expect(cell(1, 0).getAttribute('aria-selected')).toBe('true');
      });
      expect(cell(0, 0).getAttribute('aria-selected')).toBe('true');
    });

    it('selects everything with ctrl+A', async () => {
      await grid();
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'a', ctrlKey: true });
      await waitFor(() => {
        expect(cell(1, 1).getAttribute('aria-selected')).toBe('true');
      });
      expect(cell(0, 0).getAttribute('aria-selected')).toBe('true');
    });

    it('copies the selected cell as TSV through the host', async () => {
      const { copied } = await grid();
      await fireEvent.pointerDown(cell(0, 1), { button: 0 });
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'c', ctrlKey: true });
      await waitFor(() => {
        expect(copied).toHaveBeenCalledWith({ text: 'alice@example.com' });
      });
    });

    it('copies a range as rows and tabs', async () => {
      const { copied } = await grid();
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await fireEvent.pointerEnter(cell(1, 1));
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'c', ctrlKey: true });
      await waitFor(() => {
        expect(copied).toHaveBeenCalledWith({
          // NULL copies as an empty cell, which pastes as blank.
          text: '1\talice@example.com\r\n2\t',
        });
      });
    });

    it('copies nothing when no cell is selected', async () => {
      const { copied } = await grid();
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'c', ctrlKey: true });
      await flush();
      expect(copied).not.toHaveBeenCalled();
    });

    it('asks the host for exactly the selected rows', async () => {
      const harness = await grid();
      harness.handler.mockClear();
      await fireEvent.pointerDown(cell(1, 0), { button: 0 });
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'c', ctrlKey: true });
      await waitFor(() => {
        expect(harness.handler).toHaveBeenCalledWith({
          resultId: 'result-1',
          offset: 1,
          limit: 1,
        });
      });
    });
  });

  describe('sorting', () => {
    it('asks the host to sort ascending on the first header click', async () => {
      const harness = await withState({
        tabs: [tab()],
        activeId: 'result-1',
        running: false,
      });
      const sort = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
      harness.host.handle('sort', sort);
      await waitFor(() => {
        expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(1);
      });
      await fireEvent.click(screen.getByRole('button', { name: /^id/ }));
      await waitFor(() => {
        expect(sort).toHaveBeenCalledWith({ resultId: 'result-1', column: 0, direction: 'asc' });
      });
    });

    it('cycles ascending, descending, then back to the server order', async () => {
      const harness = setup();
      serveRows(harness.host);
      const sort = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
      harness.host.handle('sort', sort);
      await flush();
      harness.host.emit('state', { tabs: [tab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(1);
      });

      await fireEvent.click(screen.getByRole('button', { name: /^id/ }));
      await waitFor(() => {
        expect(sort).toHaveBeenCalledTimes(1);
      });
      // The host answers by re-sending the state with the new order.
      harness.host.emit('state', {
        tabs: [tab({ sort: { column: 0, direction: 'asc' } })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getAllByRole('columnheader')[1]?.getAttribute('aria-sort')).toBe('ascending');
      });

      await fireEvent.click(screen.getByRole('button', { name: /^id/ }));
      await waitFor(() => {
        expect(sort).toHaveBeenLastCalledWith({
          resultId: 'result-1',
          column: 0,
          direction: 'desc',
        });
      });
      harness.host.emit('state', {
        tabs: [tab({ sort: { column: 0, direction: 'desc' } })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getAllByRole('columnheader')[1]?.getAttribute('aria-sort')).toBe(
          'descending',
        );
      });

      await fireEvent.click(screen.getByRole('button', { name: /^id/ }));
      await waitFor(() => {
        expect(sort).toHaveBeenLastCalledWith({ resultId: 'result-1', column: 0 });
      });
    });

    it('starts over at ascending when another column is clicked', async () => {
      const harness = await withState({
        tabs: [tab({ sort: { column: 0, direction: 'desc' } })],
        activeId: 'result-1',
        running: false,
      });
      const sort = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
      harness.host.handle('sort', sort);
      await waitFor(() => {
        expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(2);
      });
      await fireEvent.click(screen.getByRole('button', { name: /^email/ }));
      await waitFor(() => {
        expect(sort).toHaveBeenCalledWith({ resultId: 'result-1', column: 1, direction: 'asc' });
      });
    });

    it('marks unsorted columns as such for assistive technology', async () => {
      await withState({
        tabs: [tab({ sort: { column: 0, direction: 'asc' } })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getAllByRole('columnheader')[2]?.getAttribute('aria-sort')).toBe('none');
      });
    });

    it('does not sort a failed result', async () => {
      const harness = await withState({
        tabs: [tab({ error: { code: 'syntax', message: 'bad' } })],
        activeId: 'result-1',
        running: false,
      });
      const sort = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
      harness.host.handle('sort', sort);
      await flush();
      expect(screen.queryByRole('columnheader')).toBeNull();
      expect(sort).not.toHaveBeenCalled();
    });
  });

  describe('quick search', () => {
    function serveSearch(host: HostPeer, matches: number[], total = matches.length) {
      const search = vi.fn(({ resultId }: { resultId: string }) => ({
        resultId,
        rows: matches,
        total,
      }));
      host.handle('search', search);
      return search;
    }

    it('asks the host and reports how many rows matched', async () => {
      const harness = await withState({
        tabs: [tab({ rowCount: 100 })],
        activeId: 'result-1',
        running: false,
      });
      const search = serveSearch(harness.host, [3, 7, 42]);
      await waitFor(() => {
        expect(screen.getByLabelText('Find in results')).toBeTruthy();
      });
      await fireEvent.input(screen.getByLabelText('Find in results'), {
        target: { value: 'example' },
      });
      await waitFor(() => {
        expect(search).toHaveBeenCalledWith({ resultId: 'result-1', text: 'example' });
      });
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('1 of 3');
      });
    });

    it('says when nothing matched', async () => {
      const harness = await withState({
        tabs: [tab({ rowCount: 100 })],
        activeId: 'result-1',
        running: false,
      });
      serveSearch(harness.host, []);
      await fireEvent.input(screen.getByLabelText('Find in results'), {
        target: { value: 'nobody' },
      });
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('no matches');
      });
    });

    it('steps through the matches and wraps around', async () => {
      const harness = await withState({
        tabs: [tab({ rowCount: 100 })],
        activeId: 'result-1',
        running: false,
      });
      serveSearch(harness.host, [3, 7, 42]);
      await fireEvent.input(screen.getByLabelText('Find in results'), {
        target: { value: 'example' },
      });
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('1 of 3');
      });
      await fireEvent.click(screen.getByLabelText('Next match'));
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('2 of 3');
      });
      await fireEvent.click(screen.getByLabelText('Previous match'));
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('1 of 3');
      });
      // Going back past the first match wraps to the last one.
      await fireEvent.click(screen.getByLabelText('Previous match'));
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('3 of 3');
      });
    });

    it('moves to the next match on Enter and back with Shift+Enter', async () => {
      const harness = await withState({
        tabs: [tab({ rowCount: 100 })],
        activeId: 'result-1',
        running: false,
      });
      serveSearch(harness.host, [1, 5]);
      const box = screen.getByLabelText('Find in results');
      await fireEvent.input(box, { target: { value: 'x' } });
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('1 of 2');
      });
      await fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('2 of 2');
      });
      await fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
      await waitFor(() => {
        expect(screen.getByTestId('hits').textContent.trim()).toBe('1 of 2');
      });
    });

    it('selects the row of the current match', async () => {
      const harness = await withState({
        tabs: [tab({ rowCount: 100 })],
        activeId: 'result-1',
        running: false,
      });
      serveSearch(harness.host, [1]);
      await fireEvent.input(screen.getByLabelText('Find in results'), {
        target: { value: 'bob' },
      });
      await waitFor(() => {
        const row = screen
          .getAllByRole('row')
          .find((item) => item.getAttribute('aria-rowindex') === '2');
        expect(row?.querySelector('[aria-selected="true"]')).not.toBeNull();
      });
    });

    it('clears the matches when the box is emptied', async () => {
      const harness = await withState({
        tabs: [tab({ rowCount: 100 })],
        activeId: 'result-1',
        running: false,
      });
      serveSearch(harness.host, [1]);
      const box = screen.getByLabelText('Find in results');
      await fireEvent.input(box, { target: { value: 'bob' } });
      await waitFor(() => {
        expect(screen.getByTestId('hits')).toBeTruthy();
      });
      await fireEvent.input(box, { target: { value: '' } });
      await waitFor(() => {
        expect(screen.queryByTestId('hits')).toBeNull();
      });
    });

    it('forgets the search when another tab is opened', async () => {
      const harness = await withState({
        tabs: [tab(), tab({ id: 'result-2', title: 'SELECT 2' })],
        activeId: 'result-1',
        running: false,
      });
      serveSearch(harness.host, [0]);
      await fireEvent.input(screen.getByLabelText('Find in results'), {
        target: { value: 'alice' },
      });
      await waitFor(() => {
        expect(screen.getByTestId('hits')).toBeTruthy();
      });
      await fireEvent.click(screen.getByRole('tab', { name: 'SELECT 2' }));
      await waitFor(() => {
        expect(screen.queryByTestId('hits')).toBeNull();
      });
    });
  });

  describe('messages', () => {
    it('shows the error message, where it is and a way to get there', async () => {
      const { revealed } = await withState({
        tabs: [
          tab({
            error: { code: 'syntax', message: 'near "SELEC": syntax error', position: 7 },
            rowCount: 0,
          }),
        ],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('near "SELEC": syntax error');
      });
      // Positions are counted from one for a reader, from zero in the protocol.
      expect(screen.getByTestId('error').textContent).toContain('at character 8');
      await fireEvent.click(screen.getByRole('button', { name: 'Go to the error' }));
      await waitFor(() => {
        expect(revealed).toHaveBeenCalledWith({ resultId: 'result-1' });
      });
    });

    it('omits the position when the server did not give one', async () => {
      await withState({
        tabs: [tab({ error: { code: 'timeout', message: 'too slow' }, rowCount: 0 })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('too slow');
      });
      expect(screen.getByTestId('error').textContent).not.toContain('at character');
      // The jump still works: it lands at the start of the statement.
      expect(screen.getByRole('button', { name: 'Go to the error' })).toBeTruthy();
    });

    it('reports a write by the rows it affected, with no grid', async () => {
      await withState({
        tabs: [tab({ affectedRows: 3, rowCount: 0, columns: [] })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('summary').textContent).toContain('3 rows affected');
      });
      expect(screen.queryByTestId('grid')).toBeNull();
    });

    it('reports zero rows affected rather than staying silent', async () => {
      await withState({
        tabs: [tab({ affectedRows: 0, rowCount: 0, columns: [] })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('summary').textContent).toContain('0 rows affected');
      });
    });

    it('gives every statement of a script its own tab', async () => {
      await withState({
        tabs: [
          tab({ id: 'result-1', title: 'SELECT 1', statement: 'SELECT 1' }),
          tab({ id: 'result-2', title: 'SELECT 2', statement: 'SELECT 2' }),
          tab({
            id: 'result-3',
            title: 'SELECTT 3',
            statement: 'SELECTT 3',
            error: { code: 'syntax', message: 'bad' },
          }),
        ],
        activeId: 'result-3',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(3);
      });
      // The failed statement's tab stands out and shows its message.
      expect(screen.getByTestId('error').textContent).toContain('bad');
      expect(screen.getByRole('tab', { name: 'SELECTT 3' }).className.includes('failed')).toBe(
        true,
      );
    });

    it('keeps the statement in the tab tooltip', async () => {
      await withState({
        tabs: [tab({ title: 'SELECT a, b…', statement: 'SELECT a, b FROM customers' })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByRole('tab').getAttribute('title')).toBe('SELECT a, b FROM customers');
      });
    });
  });

  describe('table view pages', () => {
    function pagedTab(overrides: Partial<ResultTab> = {}): ResultTab {
      return tab({
        statement: 'SELECT * FROM customers LIMIT 2 OFFSET 0',
        title: 'SELECT * FROM customers…',
        page: { offset: 0, pageSize: 2, totalRows: 7 },
        ...overrides,
      });
    }

    it('shows which rows of how many are on screen', async () => {
      await withState({ tabs: [pagedTab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getByTestId('pager').textContent).toContain('rows 1–2 of 7');
      });
    });

    it('has no pager for an ordinary query result', async () => {
      await withState({ tabs: [tab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getByTestId('summary')).toBeTruthy();
      });
      expect(screen.queryByTestId('pager')).toBeNull();
    });

    it('cannot go back from the first page', async () => {
      await withState({ tabs: [pagedTab()], activeId: 'result-1', running: false });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Previous' })).toBeTruthy();
      });
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(
        true,
      );
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(false);
    });

    it('asks the host for the next and the previous page', async () => {
      const harness = await withState({
        tabs: [pagedTab({ page: { offset: 2, pageSize: 2, totalRows: 7 } })],
        activeId: 'result-1',
        running: false,
      });
      const pageTo = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
      harness.host.handle('pageTo', pageTo);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() => {
        expect(pageTo).toHaveBeenCalledWith({ resultId: 'result-1', offset: 4 });
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
      await waitFor(() => {
        expect(pageTo).toHaveBeenLastCalledWith({ resultId: 'result-1', offset: 0 });
      });
    });

    it('cannot go past the last page', async () => {
      await withState({
        tabs: [pagedTab({ page: { offset: 6, pageSize: 2, totalRows: 7 }, rowCount: 1 })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('pager').textContent).toContain('rows 7–7 of 7');
      });
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    });

    it('still pages when the row count is unknown', async () => {
      await withState({
        tabs: [pagedTab({ page: { offset: 0, pageSize: 2 } })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('pager').textContent).toContain('rows 1–2');
      });
      // A full page suggests there may be more.
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(false);
    });

    it('stops at the end when a short page arrives and the count is unknown', async () => {
      await withState({
        tabs: [pagedTab({ page: { offset: 0, pageSize: 10 } })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('pager')).toBeTruthy();
      });
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    });

    it('shows an empty table honestly', async () => {
      await withState({
        tabs: [pagedTab({ rowCount: 0, page: { offset: 0, pageSize: 2, totalRows: 0 } })],
        activeId: 'result-1',
        running: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('pager').textContent).toContain('rows 0–0 of 0');
      });
    });
  });
});

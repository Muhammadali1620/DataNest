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
  host.on('ready', ready);
  host.on('selectTab', selected);
  host.on('cancel', cancelled);
  const view = render(App, { props: { rpc, t: createTranslator(lang) } });
  return { host, rpc, ready, selected, cancelled, view };
}

const ROWS = [
  [1, 'alice@example.com'],
  [2, null],
];

function serveRows(host: HostPeer, rows = ROWS): ReturnType<typeof vi.fn> {
  const handler = vi.fn(({ resultId, offset }: { resultId: string; offset: number }) => ({
    resultId,
    offset,
    rows,
    rowCount: rows.length,
  }));
  host.handle('rows', handler);
  return handler;
}

async function withState(state: ResultGridState, lang = 'en') {
  const harness = setup(lang);
  const handler = serveRows(harness.host);
  await flush();
  harness.host.emit('state', state);
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
});

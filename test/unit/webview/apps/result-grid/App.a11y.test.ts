// The result grid for keyboard and screen reader users (V9.3): one tab stop, the
// focused cell named through aria-activedescendant, positions and counts that match
// what is drawn, and states that are said in words, not only shown in colour.

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { MIN_COLUMN_WIDTH } from '../../../../../webview/src/apps/result-grid/columns';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM users',
  statement: 'SELECT * FROM users',
  columns: [{ name: 'id' }, { name: 'name' }, { name: 'note' }],
  rowCount: 3,
  truncated: false,
  durationMs: 4,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
};

const ROWS = [
  [1, 'alice', 'x'],
  [2, 'bob', 'y'],
  [3, 'carol', 'z'],
];

async function open(tab: ResultTab = TAB, lang = 'en') {
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
  host.handle('rows', ({ resultId, offset, limit }) => ({
    resultId,
    offset,
    rows: ROWS.slice(offset, offset + limit),
    rowCount: ROWS.length,
    changes: [],
    states: [],
  }));
  const sort = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
  host.handle('sort', sort);
  render(App, { props: { rpc, t: createTranslator(lang) } });
  await flush();
  host.emit('state', { tabs: [tab], activeId: tab.id, running: false });
  await waitFor(() => {
    expect(dataCells().length).toBeGreaterThan(0);
  });
  return { host, sort };
}

function grid(): HTMLElement {
  return screen.getByTestId('grid');
}

function dataCells(): HTMLElement[] {
  return screen
    .queryAllByRole('gridcell')
    .filter((item) => item.getAttribute('data-column') !== null);
}

function cell(row: number, column: number): HTMLElement {
  const found = dataCells().filter((item) => item.getAttribute('data-column') === String(column))[
    row
  ];
  if (found === undefined) {
    throw new Error(`no cell at ${row},${column}`);
  }
  return found;
}

function headerOf(column: number): HTMLElement {
  const found = screen
    .getAllByRole('columnheader')
    .find((item) => item.getAttribute('data-column') === String(column));
  if (found === undefined) {
    throw new Error(`no header for ${column}`);
  }
  return found;
}

describe('result grid for assistive technology', () => {
  it('is named after the statement and describes its keys', async () => {
    await open();
    expect(grid().getAttribute('aria-label')).toBe('SELECT * FROM users');
    const help = document.getElementById(grid().getAttribute('aria-describedby') ?? '');
    expect(help?.textContent).toContain('Shift+Alt+Up sorts by the column');
    expect(help?.classList.contains('sr-only')).toBe(true);
  });

  it('counts the header row and the row numbers among rows and columns', async () => {
    await open();
    expect(grid().getAttribute('aria-rowcount')).toBe('4');
    expect(grid().getAttribute('aria-colcount')).toBe('4');
    const rows = screen.getAllByRole('row');
    expect(rows[0]?.getAttribute('aria-rowindex')).toBe('1');
    expect(rows[1]?.getAttribute('aria-rowindex')).toBe('2');
    expect(screen.getAllByRole('rowheader')[0]?.getAttribute('aria-colindex')).toBe('1');
    expect(cell(0, 0).getAttribute('aria-colindex')).toBe('2');
    expect(cell(0, 2).getAttribute('aria-colindex')).toBe('4');
    expect(headerOf(1).getAttribute('aria-colindex')).toBe('3');
  });

  it('says the grid takes ranges and whether it can be edited', async () => {
    await open();
    expect(grid().getAttribute('aria-multiselectable')).toBe('true');
    expect(grid().getAttribute('aria-readonly')).toBe('true');
  });

  it('is one tab stop: the headers are reached by keys, not by Tab', async () => {
    await open();
    expect(grid().tabIndex).toBe(0);
    for (const button of screen
      .getAllByRole('columnheader')
      .flatMap((h) => [...h.querySelectorAll('button')])) {
      expect(button.tabIndex).toBe(-1);
    }
    for (const item of dataCells()) {
      expect(item.tabIndex).toBe(-1);
    }
  });

  it('names the focused cell for screen readers and follows the keys', async () => {
    await open();
    expect(grid().getAttribute('aria-activedescendant')).toBeNull();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await waitFor(() => {
      expect(grid().getAttribute('aria-activedescendant')).toBe(cell(0, 1).id);
    });
    await fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    await waitFor(() => {
      expect(grid().getAttribute('aria-activedescendant')).toBe(cell(1, 1).id);
    });
    expect(cell(1, 1).getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    await waitFor(() => {
      expect(grid().getAttribute('aria-activedescendant')).toBe(cell(1, 2).id);
    });
  });

  it('gives every cell its own id', async () => {
    await open();
    const ids = dataCells().map((item) => item.id);
    expect(ids.every((id) => id !== '')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts by the focused column with Shift+Alt+Up', async () => {
    const { sort } = await open();
    await fireEvent.pointerDown(cell(0, 2), { button: 0 });
    await fireEvent.keyDown(grid(), { key: 'ArrowUp', shiftKey: true, altKey: true });
    await waitFor(() => {
      expect(sort).toHaveBeenCalledWith({ resultId: 'result-1', column: 2, direction: 'asc' });
    });
  });

  it('widens and narrows the focused column with Shift+Alt+Right and Left', async () => {
    await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    const before = Number.parseInt(headerOf(1).style.width, 10);
    await fireEvent.keyDown(grid(), { key: 'ArrowRight', shiftKey: true, altKey: true });
    await waitFor(() => {
      expect(Number.parseInt(headerOf(1).style.width, 10)).toBe(before + 16);
    });
    await fireEvent.keyDown(grid(), { key: 'ArrowLeft', shiftKey: true, altKey: true });
    await fireEvent.keyDown(grid(), { key: 'ArrowLeft', shiftKey: true, altKey: true });
    await waitFor(() => {
      expect(Number.parseInt(headerOf(1).style.width, 10)).toBe(
        Math.max(MIN_COLUMN_WIDTH, before - 16),
      );
    });
    // The selection did not move or grow on the way.
    expect(grid().getAttribute('aria-activedescendant')).toBe(cell(0, 1).id);
    expect(
      dataCells().filter((item) => item.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
  });

  it('never narrows a column below the smallest width', async () => {
    await open();
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    for (let step = 0; step < 40; step++) {
      await fireEvent.keyDown(grid(), { key: 'ArrowLeft', shiftKey: true, altKey: true });
    }
    await waitFor(() => {
      expect(Number.parseInt(headerOf(0).style.width, 10)).toBe(MIN_COLUMN_WIDTH);
    });
  });

  it('does nothing with Shift+Alt keys while no cell is focused', async () => {
    const { sort } = await open();
    await fireEvent.keyDown(grid(), { key: 'ArrowUp', shiftKey: true, altKey: true });
    await flush();
    expect(sort).not.toHaveBeenCalled();
  });

  it('announces the summary of a result', async () => {
    await open();
    expect(screen.getByTestId('summary').getAttribute('role')).toBe('status');
  });

  it('describes its keys in Russian too', async () => {
    await open(TAB, 'ru');
    const help = document.getElementById(grid().getAttribute('aria-describedby') ?? '');
    expect(help?.textContent).toContain('Shift+Alt+Вверх');
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { chooseFromMenu } from '../../../../helpers/webview/menu';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM t',
  statement: 'SELECT * FROM t',
  columns: [{ name: 'id' }, { name: 'name' }, { name: 'note' }, { name: 'extra' }],
  rowCount: 2,
  truncated: false,
  durationMs: 1,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
};

const ROWS = [
  [1, 'alice', 'a long note that is rather wide indeed', 'x'],
  [2, 'bob', 'short', 'y'],
];

async function open() {
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
  const copied = vi.fn();
  host.on('copyText', copied);
  const copyAs = vi.fn((_: unknown) => ({ ok: true, rows: 2 }));
  host.handle('copyAs', copyAs);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [TAB], activeId: TAB.id, running: false });
  await waitFor(() => {
    expect(dataCells().length).toBeGreaterThan(0);
  });
  return { host, copied, copyAs };
}

function dataCells(): HTMLElement[] {
  return screen
    .queryAllByRole('gridcell')
    .filter((item) => item.getAttribute('data-column') !== null);
}

/** The column numbers (1-based) of the header cells, left to right. */
function headerOrder(): number[] {
  return screen
    .getAllByRole('columnheader')
    .filter((item) => item.getAttribute('data-column') !== null)
    .map((item) => Number(item.getAttribute('data-column')) + 1);
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

async function openMenu(): Promise<void> {
  await fireEvent.click(screen.getByTestId('columns-toggle'));
}

function item(name: string): HTMLElement {
  const found = screen
    .getAllByTestId('columns-item')
    .find((element) => element.textContent.trim().startsWith(name));
  if (found === undefined) {
    throw new Error(`no menu item ${name}`);
  }
  return found;
}

function checkbox(name: string): HTMLInputElement {
  const found = item(name).querySelector('input');
  if (found === null) {
    throw new Error(`no checkbox for ${name}`);
  }
  return found;
}

function pin(name: string): HTMLButtonElement {
  const found = item(name).querySelector('button');
  if (found === null) {
    throw new Error(`no pin for ${name}`);
  }
  return found;
}

describe('result grid column menu', () => {
  it('is closed until asked for and lists every column', async () => {
    await open();
    expect(screen.queryByTestId('columns-menu')).toBeNull();
    await openMenu();
    expect(screen.getAllByTestId('columns-item')).toHaveLength(4);
    expect(checkbox('name').checked).toBe(true);
  });

  it('hides a column from the header and from every row, and brings it back', async () => {
    await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 3, 4]);
    });
    expect(dataCells().filter((c) => c.getAttribute('data-column') === '1')).toHaveLength(0);
    expect(screen.getByTestId('columns-toggle').getAttribute('aria-label')).toBe(
      'Columns (1 hidden)',
    );
    expect(screen.getByTestId('columns-toggle').textContent.trim()).toBe('1');
    await fireEvent.click(checkbox('name'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 2, 3, 4]);
    });
  });

  it('shows every column again with one click', async () => {
    await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    await fireEvent.click(checkbox('note'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 4]);
    });
    await fireEvent.click(screen.getByTestId('columns-show-all'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 2, 3, 4]);
    });
  });

  it('keeps the last visible column', async () => {
    await open();
    await openMenu();
    for (const name of ['id', 'name', 'note']) {
      await fireEvent.click(checkbox(name));
    }
    await waitFor(() => {
      expect(headerOrder()).toEqual([4]);
    });
    await fireEvent.click(checkbox('extra'));
    await flush();
    expect(headerOrder()).toEqual([4]);
  });

  it('moves a pinned column to the front and marks it', async () => {
    await open();
    await openMenu();
    await fireEvent.click(pin('note'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([3, 1, 2, 4]);
    });
    expect(cell(0, 2).classList.contains('pinned')).toBe(true);
    expect(cell(0, 0).classList.contains('pinned')).toBe(false);
    expect(pin('note').getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(pin('note'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 2, 3, 4]);
    });
  });

  it('pins in the order the user pinned', async () => {
    await open();
    await openMenu();
    await fireEvent.click(pin('extra'));
    await fireEvent.click(pin('name'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([4, 2, 1, 3]);
    });
  });

  it('cannot pin a hidden column', async () => {
    await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    expect(pin('name').disabled).toBe(true);
  });

  it('selects and moves by what is drawn, skipping a hidden column', async () => {
    await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 3, 4]);
    });
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'ArrowRight' });
    const focused = dataCells().find((c) => c.classList.contains('focused'));
    expect(focused?.getAttribute('data-column')).toBe('2');
  });

  it('moves by the pinned order too', async () => {
    await open();
    await openMenu();
    await fireEvent.click(pin('extra'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([4, 1, 2, 3]);
    });
    await fireEvent.pointerDown(cell(0, 3), { button: 0 });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'ArrowRight' });
    const focused = dataCells().find((c) => c.classList.contains('focused'));
    expect(focused?.getAttribute('data-column')).toBe('0');
  });

  it('copies what is on screen: a selection across a hidden column skips it', async () => {
    const { copied } = await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 3, 4]);
    });
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    await fireEvent.pointerEnter(cell(1, 2), { buttons: 1 });
    await fireEvent.pointerUp(cell(1, 2));
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'c', ctrlKey: true });
    await waitFor(() => {
      expect(copied).toHaveBeenCalled();
    });
    const text = (copied.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toBe('1\ta long note that is rather wide indeed\r\n2\tshort');
  });

  it('asks the host to copy only the visible columns in the order drawn', async () => {
    const { copyAs } = await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    await fireEvent.click(pin('extra'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([4, 1, 3]);
    });
    await chooseFromMenu('copy-as', 'CSV');
    await waitFor(() => {
      expect(copyAs).toHaveBeenCalledWith({
        resultId: 'result-1',
        format: 'csv',
        columns: [3, 0, 2],
      });
    });
  });

  it('keeps the view when the same columns come back as a new result', async () => {
    const { host } = await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 3, 4]);
    });
    host.emit('state', {
      tabs: [TAB, { ...TAB, id: 'result-2', revision: 0 }],
      activeId: 'result-2',
      running: false,
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { selected: true })).toBeTruthy();
    });
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 3, 4]);
    });
  });

  it('starts plain for a result with different columns', async () => {
    const { host } = await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    host.emit('state', {
      tabs: [{ ...TAB, id: 'result-2', columns: [{ name: 'a' }, { name: 'b' }] }],
      activeId: 'result-2',
      running: false,
    });
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 2]);
    });
  });

  it('resets hiding and pinning', async () => {
    await open();
    await openMenu();
    await fireEvent.click(checkbox('name'));
    await fireEvent.click(pin('extra'));
    await fireEvent.click(screen.getByTestId('columns-reset'));
    await waitFor(() => {
      expect(headerOrder()).toEqual([1, 2, 3, 4]);
    });
    expect(screen.getByTestId<HTMLButtonElement>('columns-reset').disabled).toBe(true);
  });
});

describe('result grid column widths', () => {
  const widthOf = (index: number): number =>
    Number.parseInt(
      screen
        .getAllByRole('columnheader')
        .find((item) => item.getAttribute('data-column') === String(index))?.style.width ?? '0',
      10,
    );

  it('sizes columns from their content when the first rows arrive', async () => {
    await open();
    expect(widthOf(2)).toBeGreaterThan(widthOf(0));
  });

  it('fits every column to what is on screen on request', async () => {
    await open();
    const before = widthOf(2);
    await openMenu();
    await fireEvent.click(screen.getByTestId('columns-fit-all'));
    await waitFor(() => {
      expect(widthOf(2)).toBeGreaterThanOrEqual(before);
    });
    expect(widthOf(1)).toBeLessThan(widthOf(2));
  });

  it('fits one column when its separator is double-clicked', async () => {
    await open();
    const grip = screen
      .getAllByRole('separator')
      .find((element) => element.getAttribute('aria-label')?.includes('note'));
    expect(grip).toBeDefined();
    if (grip === undefined) {
      return;
    }
    await fireEvent.dblClick(grip);
    await waitFor(() => {
      expect(widthOf(2)).toBeGreaterThan(widthOf(3));
    });
  });

  it('remembers the sizes the user chose when the same columns come back', async () => {
    const { host } = await open();
    const grip = screen
      .getAllByRole('separator')
      .find((element) => element.getAttribute('aria-label')?.includes('name'));
    if (grip === undefined) {
      throw new Error('no separator for name');
    }
    await fireEvent.dblClick(grip);
    const chosen = widthOf(1);
    host.emit('state', {
      tabs: [TAB, { ...TAB, id: 'result-2' }],
      activeId: 'result-2',
      running: false,
    });
    await waitFor(() => {
      expect(dataCells().length).toBeGreaterThan(0);
    });
    expect(widthOf(1)).toBe(chosen);
  });
});

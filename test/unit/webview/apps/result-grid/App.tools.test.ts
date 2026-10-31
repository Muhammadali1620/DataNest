import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const ROWS: CellValue[][] = [
  [1, 'Main Hall', null],
  [2, 'VIP Room', 'note'],
  [3, 'Studio', ''],
];

function table(overrides: Partial<ResultTab> = {}): ResultTab {
  return {
    id: 'result-1',
    title: 'club_maps',
    statement: 'SELECT * FROM club_maps LIMIT 100',
    columns: [
      { name: 'id', dataType: 'int' },
      { name: 'name', dataType: 'varchar' },
      { name: 'note', dataType: 'text' },
    ],
    rowCount: 3,
    truncated: false,
    durationMs: 1,
    changedCells: 0,
    insertedRows: 0,
    deletedRows: 0,
    revision: 0,
    page: { offset: 0, pageSize: 100, totalRows: 3 },
    edit: {
      editable: true,
      columns: [
        { dataType: 'int', kind: 'integer', nullable: false },
        { dataType: 'varchar', kind: 'text', nullable: false },
        { dataType: 'text', kind: 'text', nullable: true },
      ],
    },
    ...overrides,
  };
}

async function open(tab: ResultTab = table(), tableKind?: 'view') {
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
  const reply = ({ resultId }: { resultId: string }) => ({ resultId, applied: true });
  const pageTo = vi.fn(reply);
  const pageSize = vi.fn(reply);
  const filterTable = vi.fn(reply);
  const edits = vi.fn((_: unknown) => ({ ok: true }));
  const rowActions = vi.fn((_: unknown) => ({ ok: true, row: 3 }));
  const clipboard = vi.fn(() => ({ text: 'pasted' }));
  host.handle('pageTo', pageTo);
  host.handle('pageSize', pageSize);
  host.handle('filterTable', filterTable);
  host.handle('editCell', edits);
  host.handle('rowAction', rowActions);
  host.handle('clipboardText', clipboard);
  const tableAction = vi.fn();
  const openTools = vi.fn();
  const copyText = vi.fn();
  const loadValue = vi.fn((_: unknown) => ({ ok: true }));
  const saveValue = vi.fn((_: unknown) => ({ ok: true }));
  host.handle('loadValue', loadValue);
  host.handle('saveValue', saveValue);
  host.on('tableAction', tableAction);
  host.on('openTools', openTools);
  host.on('copyText', copyText);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', {
    tabs: [tab],
    activeId: tab.id,
    running: false,
    ...(tableKind === undefined ? {} : { tableKind }),
  });
  await waitFor(() => {
    expect(
      screen.queryAllByRole('gridcell').filter((item) => item.getAttribute('data-column') !== null)
        .length,
    ).toBeGreaterThan(0);
  });
  return {
    host,
    pageTo,
    pageSize,
    filterTable,
    edits,
    rowActions,
    tableAction,
    openTools,
    copyText,
    loadValue,
    saveValue,
  };
}

function cell(row: number, column: number): HTMLElement {
  const found = screen
    .queryAllByRole('gridcell')
    .filter((item) => item.getAttribute('data-column') === String(column))[row];
  if (found === undefined) {
    throw new Error(`no cell at ${row},${column}`);
  }
  return found;
}

afterEach(() => {
  cleanup();
});

describe('the table bar', () => {
  it('shows the table tools above the SQL for a table view', async () => {
    await open();
    const bar = screen.getByTestId('table-bar');
    expect(within(bar).getByText('Properties')).toBeTruthy();
    expect(within(bar).getByText('Data').getAttribute('aria-current')).toBe('page');
    expect(within(bar).getByText('ER diagram')).toBeTruthy();
    expect(within(bar).getByText('Test data')).toBeTruthy();
    expect(within(bar).getByText('Compare')).toBeTruthy();
    expect(bar.compareDocumentPosition(screen.getByTestId('sql-bar'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('is absent for a result that is not a table view', async () => {
    const { page: _page, ...plain } = table();
    await open(plain);
    expect(screen.queryByTestId('table-bar')).toBeNull();
  });

  it.each([
    ['table-tab-properties', 'properties'],
    ['table-tab-er', 'er'],
    ['table-tab-generate', 'generate'],
    ['table-tab-compare', 'compare'],
    ['table-tab-manager', 'manager'],
    ['table-history', 'history'],
  ])('asks the host for %s', async (testid, action) => {
    const { tableAction } = await open();
    await fireEvent.click(screen.getByTestId(testid));
    await waitFor(() => {
      expect(tableAction).toHaveBeenCalledWith({
        resultId: 'result-1',
        action,
        dirty: false,
      });
    });
  });

  it('leaves out the tools only a table has when the page shows a view', async () => {
    await open(table(), 'view');
    expect(screen.getByTestId('table-tab-properties')).toBeTruthy();
    for (const id of ['er', 'generate', 'compare']) {
      expect(screen.queryByTestId(`table-tab-${id}`), id).toBeNull();
    }
    expect(screen.getByTestId('table-tab-manager')).toBeTruthy();
  });

  it('has no button that opens the page it is already on', async () => {
    await open();
    expect(screen.queryByTestId('table-tab-data')?.tagName).toBe('SPAN');
  });

  it('shows every tool as a button, with no overflow menu', async () => {
    await open();
    for (const id of ['properties', 'data', 'er', 'generate', 'compare', 'manager']) {
      expect(screen.getByTestId(`table-tab-${id}`), id).toBeTruthy();
    }
    expect(screen.queryByTestId('table-more')).toBeNull();
    expect(screen.queryByText('Show DDL')).toBeNull();
  });
});

describe('Tools and refresh buttons', () => {
  it('opens the Tools page from an icon-only button with a tooltip', async () => {
    const { openTools } = await open();
    const button = screen.getByTestId('open-tools');
    expect(button.getAttribute('aria-label')).toBe('Tools');
    expect(button.getAttribute('title')).toContain('Tools');
    expect(button.textContent.trim()).toBe('');
    expect(button.className).toContain('tools-button');
    await fireEvent.click(button);
    await waitFor(() => {
      expect(openTools).toHaveBeenCalledTimes(1);
    });
  });

  it('reads the rows again with one click on Refresh', async () => {
    const { pageTo } = await open(table({ page: { offset: 100, pageSize: 100, totalRows: 450 } }));
    const button = screen.getByTestId('refresh');
    expect(button.getAttribute('aria-label')).toBe('Refresh');
    await fireEvent.click(button);
    await waitFor(() => {
      expect(pageTo).toHaveBeenCalledWith({ resultId: 'result-1', offset: 100 });
    });
  });

  it('does not refresh over pending edits', async () => {
    await open(table({ changedCells: 1 }));
    expect(screen.getByTestId<HTMLButtonElement>('refresh').disabled).toBe(true);
  });

  it('runs the statement again for a plain query result', async () => {
    const { page: _page, ...plain } = table();
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
    host.handle('rows', ({ resultId, offset }) => ({
      resultId,
      offset,
      rows: [],
      rowCount: 0,
      changes: [],
      states: [],
    }));
    const runSql = vi.fn((_: unknown) => ({ ok: true }));
    host.handle('runSql', runSql);
    render(App, { props: { rpc, t: createTranslator('en') } });
    await flush();
    host.emit('state', { tabs: [plain], activeId: plain.id, running: false });
    await waitFor(() => {
      expect(screen.getByTestId('refresh')).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId('refresh'));
    await waitFor(() => {
      expect(runSql).toHaveBeenCalledWith({
        resultId: 'result-1',
        sql: 'SELECT * FROM club_maps LIMIT 100',
      });
    });
  });
});

describe('page size', () => {
  it('lets the user type their own size next to the presets', async () => {
    const { pageSize } = await open(table({ page: { offset: 0, pageSize: 100, totalRows: 450 } }));
    expect(screen.queryByTestId('page-size-custom')).toBeNull();
    await fireEvent.change(screen.getByTestId('page-size'), { target: { value: 'custom' } });
    const input = await screen.findByTestId<HTMLInputElement>('page-size-custom');
    await fireEvent.input(input, { target: { value: '37' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(pageSize).toHaveBeenCalledWith({ resultId: 'result-1', pageSize: 37 });
    });
  });

  it('ignores a size that is no number of rows', async () => {
    const { pageSize } = await open(table({ page: { offset: 0, pageSize: 100, totalRows: 450 } }));
    await fireEvent.change(screen.getByTestId('page-size'), { target: { value: 'custom' } });
    const input = await screen.findByTestId<HTMLInputElement>('page-size-custom');
    for (const value of ['', '0', '-3']) {
      await fireEvent.input(input, { target: { value } });
      await fireEvent.keyDown(input, { key: 'Enter' });
    }
    await flush();
    expect(pageSize).not.toHaveBeenCalled();
  });

  it('steps from page 1 when the table is bigger than a page', async () => {
    const { pageTo } = await open(table({ page: { offset: 0, pageSize: 50, totalRows: 56 } }));
    const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Next' });
    expect(next.disabled).toBe(false);
    await fireEvent.click(next);
    await waitFor(() => {
      expect(pageTo).toHaveBeenCalledWith({ resultId: 'result-1', offset: 50 });
    });
  });

  it('draws the page arrows round', async () => {
    await open(table({ page: { offset: 0, pageSize: 50, totalRows: 56 } }));
    for (const name of ['Previous', 'Next']) {
      expect(screen.getByRole('button', { name }).className).toContain('round');
    }
  });
});

describe('cell menu', () => {
  async function openMenu(row: number, column: number, tab?: ResultTab) {
    const harness = await open(tab);
    await fireEvent.contextMenu(cell(row, column));
    const menu = await screen.findByTestId('context-menu');
    return { ...harness, menu };
  }

  const labels = (menu: HTMLElement): string[] =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent.trim().replace(/\s+/gu, ' '));

  it('opens on right click with the actions of a cell', async () => {
    const { menu } = await openMenu(0, 1);
    expect(labels(menu)).toEqual([
      'Copy Ctrl+C',
      'Edit F2',
      'Duplicate rows',
      'Edit in dialog',
      'Set NULL',
      'Set empty string',
      'Load from file…',
      'Save to file…',
      "Filter: name = 'Main Hall'",
      "Filter: name ≠ 'Main Hall'",
      'Filter by',
    ]);
  });

  it('selects the cell it was opened on', async () => {
    await openMenu(1, 1);
    expect(cell(1, 1).getAttribute('aria-selected')).toBe('true');
    expect(cell(0, 1).getAttribute('aria-selected')).toBe('false');
  });

  it('disables what the cell cannot do', async () => {
    const { menu } = await openMenu(0, 1);
    // `name` is NOT NULL.
    expect(
      within(menu)
        .getByRole('menuitem', { name: /Set NULL/u })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      within(menu)
        .getByRole('menuitem', { name: /Edit in dialog/u })
        .getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('cannot edit a read-only result but still copies and filters', async () => {
    const readOnly = table({ edit: { editable: false, reason: 'no-table' } });
    const { menu } = await openMenu(0, 1, readOnly);
    for (const name of [/^Edit F2/u, /Set empty string/u, /Load from file/u, /Set NULL/u]) {
      expect(within(menu).getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe(
        'true',
      );
    }
    expect(
      within(menu).getByRole('menuitem', { name: /^Copy/u }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('filters the table by the value of the cell', async () => {
    const { filterTable } = await openMenu(1, 1);
    await fireEvent.click(await screen.findByText("Filter: name = 'VIP Room'"));
    await waitFor(() => {
      expect(filterTable).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'name', operator: 'eq', value: 'VIP Room' }] },
      });
    });
  });

  it('filters by a NULL cell with IS NULL', async () => {
    const { filterTable } = await openMenu(0, 2);
    await fireEvent.click(await screen.findByText('Filter: note is NULL'));
    await waitFor(() => {
      expect(filterTable).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'note', operator: 'isNull' }] },
      });
    });
  });

  it('opens the submenu with the other conditions', async () => {
    const { filterTable } = await openMenu(1, 1);
    await fireEvent.click(await screen.findByText('Filter by'));
    await fireEvent.click(await screen.findByText("name contains 'VIP Room'"));
    await waitFor(() => {
      expect(filterTable).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'name', operator: 'contains', value: 'VIP Room' }] },
      });
    });
  });

  it('sets NULL and the empty string through the host', async () => {
    const { edits } = await openMenu(1, 2);
    await fireEvent.click(await screen.findByText('Set NULL'));
    await waitFor(() => {
      expect(edits).toHaveBeenLastCalledWith({
        resultId: 'result-1',
        row: 1,
        column: 2,
        input: { kind: 'null' },
      });
    });
    await fireEvent.contextMenu(cell(1, 2));
    await fireEvent.click(await screen.findByText('Set empty string'));
    await waitFor(() => {
      expect(edits).toHaveBeenLastCalledWith({
        resultId: 'result-1',
        row: 1,
        column: 2,
        input: { kind: 'text', text: '' },
      });
    });
  });

  it('duplicates the selected row', async () => {
    const { rowActions } = await openMenu(1, 1);
    await fireEvent.click(await screen.findByText('Duplicate rows'));
    await waitFor(() => {
      expect(rowActions).toHaveBeenCalledWith({
        resultId: 'result-1',
        action: 'duplicate',
        rows: [1],
      });
    });
  });

  it('opens the dialog and the file actions for the cell', async () => {
    const { loadValue, saveValue } = await openMenu(1, 2);
    await fireEvent.click(await screen.findByText('Save to file…'));
    await waitFor(() => {
      expect(saveValue).toHaveBeenCalledWith({ resultId: 'result-1', row: 1, column: 2 });
    });
    await fireEvent.contextMenu(cell(1, 2));
    await fireEvent.click(await screen.findByText('Load from file…'));
    await waitFor(() => {
      expect(loadValue).toHaveBeenCalledWith({ resultId: 'result-1', row: 1, column: 2 });
    });
    await fireEvent.contextMenu(cell(1, 1));
    await fireEvent.click(await screen.findByText('Edit in dialog'));
    expect(await screen.findByTestId('value-dialog')).toBeTruthy();
  });

  it('copies the selected cell', async () => {
    const { copyText } = await openMenu(1, 1);
    await fireEvent.click(within(screen.getByTestId('context-menu')).getByText('Copy'));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith({ text: 'VIP Room' });
    });
  });

  it('closes on Escape without doing anything', async () => {
    const { edits } = await openMenu(1, 1);
    await fireEvent.keyDown(screen.getByTestId('context-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('context-menu')).toBeNull();
    expect(edits).not.toHaveBeenCalled();
  });

  it('walks the items with the arrow keys and runs one with Enter', async () => {
    const { edits } = await openMenu(1, 2);
    const menu = screen.getByTestId('context-menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    await fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(
      within(menu).getByText('Filter by').closest('[role="menuitem"]'),
    );
    await fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    const setNull = within(menu).getByText('Set NULL').closest<HTMLElement>('[role="menuitem"]');
    setNull?.focus();
    await fireEvent.keyDown(setNull ?? menu, { key: 'Enter' });
    await waitFor(() => {
      expect(edits).toHaveBeenCalled();
    });
  });

  it('closes when the pointer goes down outside it', async () => {
    await openMenu(1, 1);
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('keeps the filter button out of a result that is not a table view', async () => {
    const { page: _page, ...plain } = table();
    const { menu } = await openMenu(0, 1, plain);
    expect(labels(menu).some((label) => label.startsWith('Filter'))).toBe(false);
  });
});

describe('menu of a text box', () => {
  it('replaces the browser menu in the search box with our own', async () => {
    await open();
    const search = screen.getByPlaceholderText(/Find in results/u);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const menu = await screen.findByTestId('context-menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent.trim().replace(/\s+/gu, ' ')),
    ).toEqual([
      'Cut Ctrl+X',
      'Copy Ctrl+C',
      'Paste Ctrl+V',
      'Select all Ctrl+A',
      'Undo Ctrl+Z',
      'Redo Ctrl+Y',
    ]);
  });

  it('pastes what the host reads from the clipboard', async () => {
    await open();
    const search = screen.getByPlaceholderText<HTMLInputElement>(/Find in results/u);
    search.focus();
    search.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await fireEvent.click(await screen.findByText('Paste'));
    await waitFor(() => {
      expect(search.value).toBe('pasted');
    });
  });

  it('copies a selection through the host and cuts it out of the box', async () => {
    const { copyText } = await open();
    const search = screen.getByPlaceholderText<HTMLInputElement>(/Find in results/u);
    search.value = 'hello world';
    search.setSelectionRange(0, 5);
    search.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await fireEvent.click(await screen.findByText('Copy'));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith({ text: 'hello' });
    });
    search.setSelectionRange(0, 5);
    search.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await fireEvent.click(await screen.findByText('Cut'));
    await waitFor(() => {
      expect(search.value).toBe(' world');
    });
  });

  it('leaves Copy and Cut off when nothing is selected', async () => {
    await open();
    const search = screen.getByPlaceholderText(/Find in results/u);
    search.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = await screen.findByTestId('context-menu');
    for (const name of [/^Cut/u, /^Copy/u]) {
      expect(within(menu).getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe(
        'true',
      );
    }
  });
});

describe('menu of a shown value', () => {
  it('offers Copy and Select all on read-only value text, not the browser menu', async () => {
    const { copyText } = await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Value' }));
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    const text = await screen.findByTestId('value-text');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    text.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const menu = await screen.findByTestId('context-menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent.trim().replace(/\s+/gu, ' ')),
    ).toEqual(['Copy Ctrl+C', 'Select all Ctrl+A']);
    await fireEvent.click(within(menu).getByText('Copy'));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith({ text: text.textContent });
    });
  });
});

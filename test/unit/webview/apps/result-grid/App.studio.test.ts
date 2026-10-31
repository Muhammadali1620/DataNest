import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/svelte';
import type { CellValue } from '../../../../../src/shared/cell-value';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { VIEW_STORAGE_KEY } from '../../../../../webview/src/apps/result-grid/grid-view';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { chooseFromMenu, menuLabels } from '../../../../helpers/webview/menu';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const COLUMNS = [
  { name: 'id', dataType: 'int' },
  { name: 'name', dataType: 'jsonb' },
  { name: 'note', dataType: 'text' },
];

const EDITABLE: ResultTab = {
  id: 'result-1',
  title: 'ad_tariffs',
  statement: 'SELECT * FROM ad_tariffs LIMIT 100',
  columns: COLUMNS,
  rowCount: 3,
  truncated: false,
  durationMs: 2,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
  page: { offset: 0, pageSize: 100, totalRows: 3 },
  edit: {
    editable: true,
    columns: [
      { dataType: 'int', kind: 'integer', nullable: false },
      { dataType: 'jsonb', kind: 'json', nullable: true },
      { dataType: 'text', kind: 'text', nullable: true },
    ],
  },
};

const ROWS: CellValue[][] = [
  [1, { kind: 'json', text: '{"en":"one"}' }, 'first'],
  [2, { kind: 'json', text: '{"en":"two"}' }, 'second'],
  [3, null, 'third'],
];

async function open(tab: ResultTab = EDITABLE) {
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
  const runSql = vi.fn((_: unknown): { ok: boolean; error?: string } => ({ ok: true }));
  const edits = vi.fn((_: unknown) => ({ ok: true }));
  const rowActions = vi.fn((_: unknown) => ({ ok: true, row: 3 }));
  const pageTo = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
  host.handle('runSql', runSql);
  host.handle('editCell', edits);
  host.handle('rowAction', rowActions);
  host.handle('pageTo', pageTo);
  const sorts = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
  const filters = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
  const follows = vi.fn((_: unknown) => ({ ok: true }));
  const saves = vi.fn((_: unknown) => ({ ok: true, statements: 1, refreshed: true }));
  host.handle('sort', sorts);
  host.handle('filterTable', filters);
  host.handle('followLink', follows);
  host.handle('saveChanges', saves);
  const exported = vi.fn();
  const imported = vi.fn();
  const copied = vi.fn();
  host.on('exportResult', exported);
  host.on('importInto', imported);
  host.on('copyText', copied);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [tab], activeId: tab.id, running: false });
  await waitFor(() => {
    expect(
      screen.queryAllByRole('gridcell').filter((item) => item.getAttribute('data-column') !== null)
        .length,
    ).toBeGreaterThan(0);
  });
  return {
    host,
    runSql,
    edits,
    rowActions,
    pageTo,
    exported,
    imported,
    copied,
    sorts,
    filters,
    follows,
    saves,
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

function nth(testId: string, index: number): HTMLElement {
  const found = screen.getAllByTestId(testId)[index];
  if (found === undefined) {
    throw new Error(`no ${testId} at ${index}`);
  }
  return found;
}

function headerButton(index: number): HTMLElement {
  const found = screen.getAllByRole('columnheader')[index + 1]?.querySelector<HTMLElement>('.name');
  if (found === null || found === undefined) {
    throw new Error(`no header button at ${index}`);
  }
  return found;
}

function tickBox(row: number): HTMLElement {
  const box = screen.getAllByTestId('tick-row')[row];
  if (box === undefined) {
    throw new Error(`no check box on row ${row}`);
  }
  return box;
}

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe('the SQL bar', () => {
  it('shows the statement that produced the result', async () => {
    await open();
    expect(screen.getByTestId<HTMLTextAreaElement>('sql-input').value).toBe(
      'SELECT * FROM ad_tariffs LIMIT 100',
    );
  });

  it('runs the edited text with Ctrl+Enter', async () => {
    const { runSql } = await open();
    const input = screen.getByTestId('sql-input');
    await fireEvent.input(input, { target: { value: 'SELECT 1' } });
    await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(runSql).toHaveBeenCalledWith({ resultId: 'result-1', sql: 'SELECT 1' });
    });
  });

  it('runs with the button too, and with Cmd+Enter', async () => {
    const { runSql } = await open();
    await fireEvent.click(screen.getByTestId('sql-run'));
    await waitFor(() => {
      expect(runSql).toHaveBeenCalledTimes(1);
    });
    await fireEvent.keyDown(screen.getByTestId('sql-input'), { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(runSql).toHaveBeenCalledTimes(2);
    });
  });

  it('does not run on a plain Enter, which adds a line', async () => {
    const { runSql } = await open();
    await fireEvent.keyDown(screen.getByTestId('sql-input'), { key: 'Enter' });
    await flush();
    expect(runSql).not.toHaveBeenCalled();
  });

  it('does not run an empty statement', async () => {
    const { runSql } = await open();
    const input = screen.getByTestId('sql-input');
    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(runSql).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLButtonElement>('sql-run').disabled).toBe(true);
  });

  it('shows the server message when the statement fails', async () => {
    const { runSql } = await open();
    runSql.mockReturnValueOnce({ ok: false, error: 'syntax error at or near "SELEC"' });
    const input = screen.getByTestId('sql-input');
    await fireEvent.input(input, { target: { value: 'SELEC 1' } });
    await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect((await screen.findByTestId('sql-problem')).textContent).toContain('SELEC');
  });

  it('says so when the host gives no reason', async () => {
    const { runSql } = await open();
    runSql.mockReturnValueOnce({ ok: false });
    await fireEvent.click(screen.getByTestId('sql-run'));
    expect((await screen.findByTestId('sql-problem')).textContent).toContain('could not be run');
  });

  it('goes back to the statement that was run', async () => {
    await open();
    const input = screen.getByTestId<HTMLTextAreaElement>('sql-input');
    await fireEvent.input(input, { target: { value: 'SELECT 2' } });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Back to the statement that was run' }),
    );
    expect(input.value).toBe('SELECT * FROM ad_tariffs LIMIT 100');
  });
});

describe('row check boxes', () => {
  it('delete the ticked rows, not the selected cell', async () => {
    const { rowActions } = await open();
    await fireEvent.click(tickBox(0));
    await fireEvent.click(tickBox(2));
    expect((await screen.findByTestId('tick-count')).textContent).toBe('2 ticked');
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(rowActions).toHaveBeenCalledWith({
        resultId: 'result-1',
        action: 'delete',
        rows: [0, 2],
      });
    });
  });

  it('tick every row with the header box, and clear them with it', async () => {
    const { rowActions } = await open();
    await fireEvent.click(screen.getByTestId('tick-all'));
    expect((await screen.findByTestId('tick-count')).textContent).toBe('3 ticked');
    await fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => {
      expect(rowActions).toHaveBeenCalledWith({
        resultId: 'result-1',
        action: 'duplicate',
        rows: [0, 1, 2],
      });
    });
    await fireEvent.click(screen.getByTestId('tick-all'));
    await waitFor(() => {
      expect(screen.queryByTestId('tick-count')).toBeNull();
    });
  });

  it('can be turned off in the view settings', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Row check boxes' }));
    await waitFor(() => {
      expect(screen.queryAllByTestId('tick-row')).toHaveLength(0);
    });
  });
});

describe('the edit bar', () => {
  it('is made of icons: every button has a name and none has a label', async () => {
    await open();
    const bar = screen.getByTestId('editbar');
    const buttons = within(bar).getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(7);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label') ?? '').not.toBe('');
      // No text label: the only content is the icon glyph (and a count badge).
      expect(button.textContent.trim()).toBe('');
      expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
    }
  });

  it('sits above the grid, not below it', async () => {
    await open();
    const bar = screen.getByTestId('editbar');
    const grid = screen.getByTestId('grid');
    expect(bar.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the value dialog', () => {
  it('opens from the magnifier on a cell and shows the full value', async () => {
    await open();
    await fireEvent.click(within(cell(0, 1)).getByTestId('cell-dialog'));
    const area = await screen.findByTestId<HTMLTextAreaElement>('value-dialog-text');
    // A JSON value opens formatted.
    expect(area.value).toBe('{\n  "en": "one"\n}');
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Value');
  });

  it('has no magnifier on numbers or NULL', async () => {
    await open();
    expect(within(cell(0, 0)).queryByTestId('cell-dialog')).toBeNull();
    expect(within(cell(2, 1)).queryByTestId('cell-dialog')).toBeNull();
  });

  it('saves the text into the cell compactly for JSON, and closes', async () => {
    const { edits } = await open();
    await fireEvent.click(within(cell(0, 1)).getByTestId('cell-dialog'));
    const area = await screen.findByTestId('value-dialog-text');
    await fireEvent.input(area, { target: { value: '{\n "en": "uno"\n}' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(edits).toHaveBeenCalledWith({
        resultId: 'result-1',
        row: 0,
        column: 1,
        input: { kind: 'text', text: '{"en":"uno"}' },
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('value-dialog')).toBeNull();
    });
  });

  it('saves with Ctrl+Enter and closes with Escape', async () => {
    const { edits } = await open();
    await fireEvent.click(within(cell(0, 2)).getByTestId('cell-dialog'));
    const area = await screen.findByTestId('value-dialog-text');
    await fireEvent.input(area, { target: { value: 'changed' } });
    await fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(edits).toHaveBeenCalledTimes(1);
    });
    await fireEvent.click(within(cell(1, 2)).getByTestId('cell-dialog'));
    await screen.findByTestId('value-dialog');
    await fireEvent.keyDown(screen.getByTestId('value-dialog-text'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('value-dialog')).toBeNull();
    });
  });

  it('keeps the dialog open and says why when the cell refuses the text', async () => {
    const { edits } = await open();
    edits.mockReturnValueOnce({ ok: false });
    await fireEvent.click(within(cell(0, 2)).getByTestId('cell-dialog'));
    await fireEvent.input(await screen.findByTestId('value-dialog-text'), {
      target: { value: 'x' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByTestId('dialog-problem')).textContent).not.toBe('');
    expect(screen.getByTestId('value-dialog')).toBeTruthy();
  });

  it('formats and compacts JSON and refuses what is not JSON', async () => {
    await open();
    await fireEvent.click(within(cell(0, 1)).getByTestId('cell-dialog'));
    const area = await screen.findByTestId<HTMLTextAreaElement>('value-dialog-text');
    await fireEvent.click(screen.getByRole('button', { name: 'Compact JSON' }));
    expect(area.value).toBe('{"en":"one"}');
    await fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(area.value).toBe('{\n  "en": "one"\n}');
    await fireEvent.input(area, { target: { value: '{broken' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect((await screen.findByTestId('dialog-problem')).textContent).toContain('not valid JSON');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('copies through the host', async () => {
    const { copied } = await open();
    await fireEvent.click(within(cell(0, 2)).getByTestId('cell-dialog'));
    await screen.findByTestId('value-dialog');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(copied).toHaveBeenCalledWith({ text: 'first' });
    });
  });

  it('is read-only for a result that cannot be edited', async () => {
    await open({ ...EDITABLE, edit: { editable: false, reason: 'no-key' } });
    await fireEvent.click(within(cell(0, 2)).getByTestId('cell-dialog'));
    const area = await screen.findByTestId<HTMLTextAreaElement>('value-dialog-text');
    expect(area.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('export and import', () => {
  it('offers the dialog from the Export menu', async () => {
    await open();
    expect(await menuLabels('export')).toContain('More options…');
  });

  it('exports the whole table in the chosen format', async () => {
    const { exported } = await open();
    await chooseFromMenu('export', 'More options…');
    await fireEvent.click(await screen.findByTestId('export-scope-table'));
    await fireEvent.click(screen.getByTestId('export-format-csv'));
    await fireEvent.click(screen.getByTestId('export-run'));
    await waitFor(() => {
      expect(exported).toHaveBeenCalledWith({
        resultId: 'result-1',
        format: 'csv',
        scope: 'table',
      });
    });
    expect(screen.queryByTestId('export-dialog')).toBeNull();
  });

  it('exports every table of the database', async () => {
    const { exported } = await open();
    await chooseFromMenu('export', 'More options…');
    await fireEvent.click(await screen.findByTestId('export-scope-database'));
    await fireEvent.click(screen.getByTestId('export-run'));
    await waitFor(() => {
      expect(exported).toHaveBeenCalledWith({
        resultId: 'result-1',
        format: 'xlsx',
        scope: 'database',
      });
    });
  });

  it('exports these rows by default', async () => {
    const { exported } = await open();
    await chooseFromMenu('export', 'More options…');
    await fireEvent.click(await screen.findByTestId('export-run'));
    await waitFor(() => {
      expect(exported).toHaveBeenCalledWith({
        resultId: 'result-1',
        format: 'xlsx',
        scope: 'result',
      });
    });
  });

  it('offers only the result when it is not a table view', async () => {
    const { page: _page, ...query } = EDITABLE;
    await open(query);
    await chooseFromMenu('export', 'More options…');
    await screen.findByTestId('export-dialog');
    expect(screen.queryByTestId('export-scope-table')).toBeNull();
    expect(screen.queryByTestId('export-scope-database')).toBeNull();
  });

  it('closes the dialog with Escape and with its button', async () => {
    await open();
    await chooseFromMenu('export', 'More options…');
    await fireEvent.keyDown(await screen.findByTestId('export-dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('export-dialog')).toBeNull();
    });
  });

  it('asks the host to open the import page for a table view', async () => {
    const { imported } = await open();
    await fireEvent.click(screen.getByTestId('import'));
    await waitFor(() => {
      expect(imported).toHaveBeenCalledWith({ resultId: 'result-1' });
    });
  });

  it('has no import button for a query result', async () => {
    const { page: _page, ...query } = EDITABLE;
    await open(query);
    expect(screen.queryByTestId('import')).toBeNull();
  });
});

describe('the view settings', () => {
  it('open from the toolbar and close again', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    expect(await screen.findByTestId('view-settings')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByTestId('view-settings')).toBeNull();
    });
  });

  it('change the row height and the text size, and remember them', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    await fireEvent.click(screen.getByRole('button', { name: 'Taller rows' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Taller rows' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Taller rows' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Taller rows' }));
    await fireEvent.click(screen.getByRole('button', { name: '16' }));
    const grid = screen.getByTestId('grid');
    expect(grid.style.getPropertyValue('--dn-row-height')).toBe('40px');
    expect(grid.style.getPropertyValue('--dn-grid-font')).toBe('16px');
    const stored = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({ rowHeight: 40, fontSize: 16 });
  });

  it('start from what was stored', async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ rowHeight: 26, lines: 'all' }));
    await open();
    const grid = screen.getByTestId('grid');
    expect(grid.style.getPropertyValue('--dn-row-height')).toBe('26px');
    expect(grid.classList.contains('lines-all')).toBe(true);
  });

  it('hide the row numbers and go back to the defaults', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Row numbers' }));
    await waitFor(() => {
      expect(document.querySelectorAll('.rownum .num')).toHaveLength(0);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => {
      expect(document.querySelectorAll('.rownum .num').length).toBeGreaterThan(0);
    });
  });
});

describe('auto refresh', () => {
  it('is off until chosen and reads the same page again on a timer', async () => {
    const { pageTo } = await open();
    expect(await menuLabels('auto-refresh')).toEqual([
      'Off',
      'Every 1 s',
      'Every 3 s',
      'Every 5 s',
      'Every 30 s',
      'Every 60 s',
      'Every 300 s',
    ]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await chooseFromMenu('auto-refresh', 'Every 3 s');
    // Choosing it also refreshes right away.
    await vi.waitFor(() => {
      expect(pageTo).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(3100);
    await vi.waitFor(() => {
      expect(pageTo).toHaveBeenCalledTimes(2);
    });
    expect(pageTo).toHaveBeenLastCalledWith({ resultId: 'result-1', offset: 0 });
  });

  it('stops when switched off', async () => {
    const { pageTo } = await open();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await chooseFromMenu('auto-refresh', 'Every 1 s');
    await vi.waitFor(() => {
      expect(pageTo).toHaveBeenCalledTimes(1);
    });
    await chooseFromMenu('auto-refresh', 'Off');
    await vi.advanceTimersByTimeAsync(5000);
    expect(pageTo).toHaveBeenCalledTimes(1);
  });

  it('runs the statement again for a query result', async () => {
    const { page: _page, ...query } = EDITABLE;
    const { runSql } = await open(query);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await chooseFromMenu('auto-refresh', 'Every 5 s');
    await vi.waitFor(() => {
      expect(runSql).toHaveBeenCalledWith({
        resultId: 'result-1',
        sql: 'SELECT * FROM ad_tariffs LIMIT 100',
      });
    });
  });
});

describe('the pager', () => {
  it('sits in the toolbar, not in the status bar', async () => {
    await open();
    const pager = screen.getByTestId('pager');
    expect(pager.closest('footer')).toBeNull();
    expect(pager.closest('.toolbar-row')).not.toBeNull();
  });
});

describe('the column header', () => {
  it('shows the type under the name', async () => {
    await open();
    const headers = screen.getAllByRole('columnheader');
    expect(headers[2]?.textContent.replace(/\s+/g, ' ').trim()).toBe('name jsonb');
  });
});

describe('ordering from the header', () => {
  it('has an up and a down arrow on every column', async () => {
    await open();
    expect(screen.getAllByTestId('sort-asc')).toHaveLength(3);
    expect(screen.getAllByTestId('sort-desc')).toHaveLength(3);
  });

  it('orders ascending and descending, each on its own button', async () => {
    const { sorts } = await open();
    await fireEvent.click(nth('sort-desc', 2));
    await waitFor(() => {
      expect(sorts).toHaveBeenCalledWith({ resultId: 'result-1', column: 2, direction: 'desc' });
    });
    await fireEvent.click(nth('sort-asc', 0));
    await waitFor(() => {
      expect(sorts).toHaveBeenLastCalledWith({ resultId: 'result-1', column: 0, direction: 'asc' });
    });
  });

  it('takes the order off when the active arrow is pressed again', async () => {
    const { sorts } = await open({ ...EDITABLE, sort: { column: 1, direction: 'desc' } });
    const down = nth('sort-desc', 1);
    expect(down.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(down);
    await waitFor(() => {
      expect(sorts).toHaveBeenCalledWith({ resultId: 'result-1', column: 1 });
    });
  });

  it('keeps the header click that cycles through the orders', async () => {
    const { sorts } = await open();
    await fireEvent.click(headerButton(1));
    await waitFor(() => {
      expect(sorts).toHaveBeenCalledWith({ resultId: 'result-1', column: 1, direction: 'asc' });
    });
  });
});

describe('filtering from the header', () => {
  async function openFilter(column: number) {
    const harness = await open();
    await fireEvent.click(nth('column-filter', column));
    await screen.findByTestId('column-filter-popover');
    return harness;
  }

  it('offers the funnel for a table view only', async () => {
    const { page: _page, ...query } = EDITABLE;
    await open(query);
    expect(screen.queryAllByTestId('column-filter')).toHaveLength(0);
  });

  it('lists the values in the loaded rows and filters by the one clicked', async () => {
    const { filters } = await openFilter(2);
    const list = screen.getByTestId('colfilter-values');
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['first', 'second', 'third']);
    await fireEvent.click(within(list).getByRole('button', { name: 'second' }));
    await waitFor(() => {
      expect(filters).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'note', operator: 'eq', value: 'second' }] },
      });
    });
    expect(screen.queryByTestId('column-filter-popover')).toBeNull();
  });

  it('filters by a condition typed in, with Enter', async () => {
    const { filters } = await openFilter(2);
    await fireEvent.input(screen.getByTestId('colfilter-value'), { target: { value: 'ir' } });
    await fireEvent.keyDown(screen.getByTestId('column-filter-popover'), { key: 'Enter' });
    await waitFor(() => {
      expect(filters).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'note', operator: 'contains', value: 'ir' }] },
      });
    });
  });

  it('needs a value, except for NULL checks', async () => {
    const { filters } = await openFilter(2);
    expect(screen.getByTestId<HTMLButtonElement>('colfilter-apply').disabled).toBe(true);
    await fireEvent.change(screen.getByTestId('colfilter-operator'), {
      target: { value: 'isNull' },
    });
    await waitFor(() => {
      expect(screen.queryByTestId('colfilter-value')).toBeNull();
    });
    await fireEvent.click(screen.getByTestId('colfilter-apply'));
    await waitFor(() => {
      expect(filters).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'note', operator: 'isNull' }] },
      });
    });
  });

  it('narrows the value list by search', async () => {
    await openFilter(2);
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'sec' },
    });
    expect(
      within(screen.getByTestId('colfilter-values'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['second']);
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No value matches')).toBeTruthy();
  });

  it('starts from the column’s present condition and clears only that column', async () => {
    const tab: ResultTab = {
      ...EDITABLE,
      filter: {
        conditions: [
          { column: 'note', operator: 'startsWith', value: 'f' },
          { column: 'id', operator: 'gt', value: '0' },
        ],
      },
    };
    const harness = await open(tab);
    // The funnels of the filtered columns are marked.
    expect(screen.getAllByTestId('column-filter')[2]?.className).toContain('on');
    expect(screen.getAllByTestId('column-filter')[1]?.className).not.toContain('on');
    await fireEvent.click(nth('column-filter', 2));
    expect(screen.getByTestId<HTMLInputElement>('colfilter-value').value).toBe('f');
    expect(screen.getByTestId<HTMLSelectElement>('colfilter-operator').value).toBe('startsWith');
    await fireEvent.click(screen.getByTestId('colfilter-clear'));
    await waitFor(() => {
      expect(harness.filters).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'id', operator: 'gt', value: '0' }] },
      });
    });
  });

  it('closes with Escape, the close button and a press outside', async () => {
    await openFilter(1);
    await fireEvent.keyDown(screen.getByTestId('column-filter-popover'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('column-filter-popover')).toBeNull();
    });
    await fireEvent.click(nth('column-filter', 1));
    await screen.findByTestId('column-filter-popover');
    await fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId('column-filter-popover')).toBeNull();
    });
  });

  it('closes when the funnel is pressed again', async () => {
    await openFilter(0);
    await fireEvent.click(nth('column-filter', 0));
    await waitFor(() => {
      expect(screen.queryByTestId('column-filter-popover')).toBeNull();
    });
  });
});

describe('the fields of a row, top to bottom', () => {
  it('opens under the row with every field, and closes again', async () => {
    await open();
    await fireEvent.click(nth('row-expand', 0));
    const detail = await screen.findByTestId('row-detail');
    const names = Array.from(detail.querySelectorAll('dt')).map((item) => item.textContent);
    expect(names).toEqual(['id', 'name', 'note']);
    const values = Array.from(detail.querySelectorAll('dd')).map((item) => item.textContent);
    expect(values).toEqual(['1', '{"en":"one"}', 'first']);
    await fireEvent.click(nth('row-expand', 0));
    await waitFor(() => {
      expect(screen.queryByTestId('row-detail')).toBeNull();
    });
  });

  it('is open for one row at a time and pushes the rows after it down', async () => {
    await open();
    const rowsBefore = screen.getAllByRole('row').slice(1);
    const topOf = (index: number): string => rowsBefore[index]?.style.top ?? '';
    const secondBefore = topOf(1);
    await fireEvent.click(nth('row-expand', 0));
    await screen.findByTestId('row-detail');
    const rowsAfter = screen.getAllByRole('row').slice(1);
    expect(rowsAfter[0]?.style.top).toBe(topOf(0));
    expect(Number.parseInt(rowsAfter[1]?.style.top ?? '0', 10)).toBeGreaterThan(
      Number.parseInt(secondBefore, 10),
    );
    await fireEvent.click(nth('row-expand', 1));
    await waitFor(() => {
      expect(screen.getAllByTestId('row-detail')).toHaveLength(1);
    });
    expect(screen.getByTestId('row-detail').textContent).toContain('second');
  });

  it('marks the arrow as open for screen readers', async () => {
    await open();
    const arrow = nth('row-expand', 0);
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(arrow);
    await waitFor(() => {
      expect(arrow.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('shows NULL as NULL', async () => {
    await open();
    await fireEvent.click(nth('row-expand', 2));
    const detail = await screen.findByTestId('row-detail');
    expect(detail.querySelector('dd.null')?.textContent).toBe('NULL');
  });
});

describe('inserting a row with a form', () => {
  async function openForm() {
    const harness = await open();
    await fireEvent.click(screen.getByTestId('insert-dialog-open'));
    await screen.findByTestId('insert-dialog');
    return harness;
  }

  it('has a field for every column that can be edited, with its type', async () => {
    await openForm();
    const labels = Array.from(document.querySelectorAll('.insert-label, .fields label')).map(
      (item) => item.textContent.replace(/\s+/g, ' ').trim(),
    );
    expect(labels).toEqual(['*id int', 'name jsonb', 'note text']);
  });

  it('adds the row, fills only what was typed and saves', async () => {
    const { rowActions, edits, saves } = await openForm();
    await fireEvent.input(screen.getByLabelText(/^\*id/), { target: { value: '9' } });
    await fireEvent.input(screen.getByLabelText(/^note/), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByTestId('insert-run'));
    await waitFor(() => {
      expect(saves).toHaveBeenCalledTimes(1);
    });
    expect(rowActions).toHaveBeenCalledWith({ resultId: 'result-1', action: 'add', rows: [] });
    expect(edits.mock.calls.map(([call]) => call)).toEqual([
      { resultId: 'result-1', row: 3, column: 0, input: { kind: 'text', text: '9' } },
      { resultId: 'result-1', row: 3, column: 2, input: { kind: 'text', text: 'hello' } },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId('insert-dialog')).toBeNull();
    });
  });

  it('inserts with Ctrl+Enter', async () => {
    const { saves } = await openForm();
    await fireEvent.keyDown(screen.getByTestId('insert-dialog'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(saves).toHaveBeenCalledTimes(1);
    });
  });

  it('stays open with the reason when a field is refused', async () => {
    const { edits, saves } = await openForm();
    edits.mockReturnValueOnce({ ok: false, error: 'invalid-integer' } as never);
    await fireEvent.input(screen.getByLabelText(/^\*id/), { target: { value: 'x' } });
    await fireEvent.click(screen.getByTestId('insert-run'));
    expect((await screen.findByTestId('insert-problem')).textContent).toContain('id');
    expect(saves).not.toHaveBeenCalled();
    expect(screen.getByTestId('insert-dialog')).toBeTruthy();
  });

  it('says so when the row cannot be added', async () => {
    const { rowActions, saves } = await openForm();
    rowActions.mockReturnValueOnce({ ok: false } as never);
    await fireEvent.click(screen.getByTestId('insert-run'));
    expect(await screen.findByTestId('insert-problem')).toBeTruthy();
    expect(saves).not.toHaveBeenCalled();
  });

  it('closes with Escape and its button without adding anything', async () => {
    const { rowActions } = await openForm();
    await fireEvent.keyDown(screen.getByTestId('insert-dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('insert-dialog')).toBeNull();
    });
    expect(rowActions).not.toHaveBeenCalled();
  });

  it('has no form for a result that cannot be edited, and keeps Add row for the rest', async () => {
    await open({ ...EDITABLE, edit: { editable: false, reason: 'no-key' } });
    expect(screen.queryByTestId('insert-dialog-open')).toBeNull();
    cleanup();
    await open();
    expect(screen.getByRole('button', { name: 'Add row' })).toBeTruthy();
  });

  it('offers a list for an enum or boolean column', async () => {
    const tab: ResultTab = {
      ...EDITABLE,
      edit: {
        editable: true,
        columns: [
          { dataType: 'int', kind: 'integer', nullable: false },
          { dataType: 'boolean', kind: 'boolean', nullable: true },
          { dataType: "enum('a','b')", kind: 'enum', nullable: true, options: ['a', 'b'] },
        ],
      },
    };
    await open(tab);
    await fireEvent.click(screen.getByTestId('insert-dialog-open'));
    const selects = screen.getByTestId('insert-dialog').querySelectorAll('select');
    expect(Array.from(selects[0]?.options ?? []).map((option) => option.value)).toEqual([
      '',
      'true',
      'false',
    ]);
    expect(Array.from(selects[1]?.options ?? []).map((option) => option.value)).toEqual([
      '',
      'a',
      'b',
    ]);
  });
});

describe('the jump to a related row', () => {
  const LINKED: ResultTab = { ...EDITABLE, links: [{ id: 1, columns: [0], target: 'orders' }] };

  it('is a button on the cell, named after the table', async () => {
    await open(LINKED);
    const button = within(cell(0, 0)).getByTestId('cell-link');
    expect(button.getAttribute('aria-label')).toContain('orders');
  });

  it('opens the related row when pressed', async () => {
    const { follows } = await open(LINKED);
    await fireEvent.click(within(cell(1, 0)).getByTestId('cell-link'));
    await waitFor(() => {
      expect(follows).toHaveBeenCalledWith({ resultId: 'result-1', row: 1, link: 1 });
    });
  });

  it('still opens with Ctrl+click', async () => {
    const { follows } = await open(LINKED);
    await fireEvent.pointerDown(cell(0, 0), { button: 0, ctrlKey: true });
    await waitFor(() => {
      expect(follows).toHaveBeenCalledTimes(1);
    });
  });

  it('is absent from cells with nothing to point at, and from other columns', async () => {
    await open({ ...LINKED, links: [{ id: 1, columns: [1], target: 'orders' }] });
    expect(within(cell(2, 1)).queryByTestId('cell-link')).toBeNull();
    expect(within(cell(0, 0)).queryByTestId('cell-link')).toBeNull();
    expect(within(cell(0, 1)).getByTestId('cell-link')).toBeTruthy();
  });

  it('sits beside the magnifier on a text key', async () => {
    await open({ ...LINKED, links: [{ id: 1, columns: [2], target: 'orders' }] });
    const target = cell(0, 2);
    expect(within(target).getByTestId('cell-link')).toBeTruthy();
    expect(within(target).getByTestId('cell-dialog')).toBeTruthy();
  });
});

describe('typing JSON in the dialog', () => {
  async function area() {
    await open();
    await fireEvent.click(within(cell(0, 1)).getByTestId('cell-dialog'));
    const box = await screen.findByTestId<HTMLTextAreaElement>('value-dialog-text');
    return box;
  }

  it('closes a bracket and keeps the caret between', async () => {
    const box = await area();
    await fireEvent.input(box, { target: { value: '' } });
    box.setSelectionRange(0, 0);
    await fireEvent.keyDown(box, { key: '{' });
    await waitFor(() => {
      expect(box.value).toBe('{}');
      expect(box.selectionStart).toBe(1);
    });
  });

  it('indents on Enter between brackets', async () => {
    const box = await area();
    await fireEvent.input(box, { target: { value: '{}' } });
    box.setSelectionRange(1, 1);
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(box.value).toBe('{\n  \n}');
      expect(box.selectionStart).toBe(4);
    });
  });

  it('leaves the keys alone in text mode and with a modifier', async () => {
    const box = await area();
    await fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    await fireEvent.input(box, { target: { value: '' } });
    box.setSelectionRange(0, 0);
    await fireEvent.keyDown(box, { key: '{' });
    expect(box.value).toBe('');
    await fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    await fireEvent.input(box, { target: { value: '' } });
    await fireEvent.keyDown(box, { key: '{', ctrlKey: true });
    expect(box.value).toBe('');
  });

  it('does not edit a value that cannot be edited', async () => {
    await open({ ...EDITABLE, edit: { editable: false, reason: 'no-key' } });
    await fireEvent.click(within(cell(0, 1)).getByTestId('cell-dialog'));
    const box = await screen.findByTestId<HTMLTextAreaElement>('value-dialog-text');
    box.setSelectionRange(0, 0);
    await fireEvent.keyDown(box, { key: '{' });
    expect(box.value).toBe('{\n  "en": "one"\n}');
  });
});

describe('more ways to look', () => {
  async function chooseView(name: string) {
    if (screen.queryByTestId('view-settings') === null) {
      await fireEvent.click(screen.getByTestId('view-toggle'));
    }
    await fireEvent.click(
      within(screen.getByTestId('view-settings')).getByRole('button', { name }),
    );
  }

  it('shows the rows as JSON', async () => {
    await open();
    await chooseView('JSON');
    const json = await screen.findByTestId('layout-json');
    expect(JSON.parse(json.textContent)).toEqual([
      { id: 1, name: { en: 'one' }, note: 'first' },
      { id: 2, name: { en: 'two' }, note: 'second' },
      { id: 3, name: null, note: 'third' },
    ]);
    expect(screen.getByTestId('grid').closest('.grid-wrap')?.className).toContain('hidden');
  });

  it('shows the fields running down when reversed, and the table again', async () => {
    await open();
    await chooseView('Reversed');
    const table = await screen.findByTestId('layout-transposed');
    const heads = Array.from(table.querySelectorAll('thead th')).map((item) => item.textContent);
    expect(heads).toEqual(['Field', 'Row 1', 'Row 2', 'Row 3']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    await chooseView('Table');
    await waitFor(() => {
      expect(screen.queryByTestId('result-layout')).toBeNull();
    });
  });

  it('draws only vertical lines, and code font, when asked', async () => {
    await open();
    await chooseView('Columns');
    await chooseView('Code');
    const grid = screen.getByTestId('grid');
    expect(grid.classList.contains('lines-columns')).toBe(true);
    expect(grid.style.fontFamily).toContain('--dn-mono');
  });

  it('hides the execution time', async () => {
    await open();
    expect(screen.getByTestId('summary').textContent).toContain('2 ms');
    await fireEvent.click(screen.getByTestId('view-toggle'));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Execution time' }));
    await waitFor(() => {
      expect(screen.getByTestId('summary').textContent).not.toContain('ms');
    });
  });

  it('opens the column settings from the view menu', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    await fireEvent.click(screen.getByTestId('view-columns'));
    expect(await screen.findByTestId('columns-menu')).toBeTruthy();
    expect(screen.queryByTestId('view-settings')).toBeNull();
  });

  it('lowers and raises the rows one step at a time, within limits', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    for (let press = 0; press < 20; press += 1) {
      await fireEvent.click(screen.getByRole('button', { name: 'Lower rows' }));
    }
    expect(screen.getByTestId('row-height').textContent).toBe('20');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Lower rows' }).disabled).toBe(
      true,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Taller rows' }));
    expect(screen.getByTestId('row-height').textContent).toBe('22');
  });

  it('reorders columns by dragging a header when that is on', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Drag columns by the header' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const heads = screen.getAllByRole('columnheader').slice(1);
    const grab = headerButton(2);
    expect(grab.getAttribute('draggable')).toBe('true');
    await fireEvent.dragStart(grab);
    await fireEvent.dragOver(heads[0] ?? grab);
    await fireEvent.drop(heads[0] ?? grab);
    await waitFor(() => {
      const names = screen
        .getAllByRole('columnheader')
        .slice(1)
        .map((item) => item.querySelector('.label')?.textContent);
      expect(names).toEqual(['note', 'id', 'name']);
    });
  });

  it('does not drag columns unless asked', async () => {
    await open();
    const grab = headerButton(0);
    expect(grab.getAttribute('draggable')).toBe('false');
  });
});

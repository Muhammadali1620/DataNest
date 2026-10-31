import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const rowActions = vi.fn((_: unknown) => ({ ok: true }));
  const pageTo = vi.fn(({ resultId }: { resultId: string }) => ({ resultId, applied: true }));
  host.handle('runSql', runSql);
  host.handle('editCell', edits);
  host.handle('rowAction', rowActions);
  host.handle('pageTo', pageTo);
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
  return { host, runSql, edits, rowActions, pageTo, exported, imported, copied };
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
    await fireEvent.click(screen.getByRole('button', { name: 'Roomy' }));
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

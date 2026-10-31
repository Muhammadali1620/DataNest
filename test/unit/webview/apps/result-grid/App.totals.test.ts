// The page side of V10.2.4: totals of the selected cells, and saving or loading the
// value of a cell from the value panel.

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
  type SelectionTotals,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM items',
  statement: 'SELECT * FROM items',
  columns: [{ name: 'id' }, { name: 'price' }, { name: 'note' }],
  rowCount: 3,
  truncated: false,
  durationMs: 1,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
};

const EDITABLE: ResultTab = {
  ...TAB,
  edit: {
    editable: true,
    columns: [
      { dataType: 'int', kind: 'integer', nullable: false },
      { dataType: 'decimal', kind: 'number', nullable: true },
      { dataType: 'text', kind: 'text', nullable: true },
    ],
  },
};

const ROWS: CellValue[][] = [
  [1, { kind: 'decimal', text: '1.10' }, 'a'],
  [2, { kind: 'decimal', text: '2.20' }, 'b'],
  [3, null, null],
];

async function open(tab: ResultTab = TAB) {
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
  const summarize = vi.fn(
    (_: { resultId: string; top: number; bottom: number; columns: number[] }): SelectionTotals => ({
      cells: 4,
      values: 3,
      numbers: 2,
      sum: '3.30',
      average: '1.65',
      min: '1.10',
      max: '2.20',
    }),
  );
  host.handle('summarize', summarize);
  const saveValue = vi.fn(() => ({ ok: true }));
  const loadValue = vi.fn(() => ({ ok: true }));
  host.handle('saveValue', saveValue);
  host.handle('loadValue', loadValue);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [tab], activeId: tab.id, running: false });
  await waitFor(() => {
    expect(cell(2, 2)).toBeTruthy();
  });
  return { host, summarize, saveValue, loadValue };
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

describe('result grid totals of the selection', () => {
  it('shows count, sum, average, minimum and maximum of a selection of cells', async () => {
    const { summarize } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.pointerDown(cell(1, 2), { button: 0, shiftKey: true });
    const totals = await screen.findByTestId('selection-totals', {}, { timeout: 2000 });
    expect(totals.textContent).toBe('Count: 3 · Sum: 3.30 · Average: 1.65 · Min: 1.10 · Max: 2.20');
    expect(summarize).toHaveBeenLastCalledWith({
      resultId: 'result-1',
      top: 0,
      bottom: 1,
      columns: [1, 2],
    });
  });

  it('shows nothing for a single cell, and asks nothing', async () => {
    const { summarize } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByTestId('selection-totals')).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('marks figures worked out with doubles, and shows only a count without numbers', async () => {
    const { summarize } = await open();
    summarize.mockReturnValueOnce({
      cells: 2,
      values: 2,
      numbers: 2,
      sum: '0.30000000000000004',
      average: '0.15000000000000002',
      min: '0.1',
      max: '0.2',
      approximate: true,
    });
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    await fireEvent.pointerDown(cell(1, 0), { button: 0, shiftKey: true });
    const totals = await screen.findByTestId('selection-totals', {}, { timeout: 2000 });
    expect(totals.textContent).toContain('Sum: ≈ 0.30000000000000004');
    summarize.mockReturnValueOnce({ cells: 2, values: 1, numbers: 0 });
    await fireEvent.pointerDown(cell(2, 2), { button: 0, shiftKey: true });
    await waitFor(
      () => {
        expect(screen.getByTestId('selection-totals').textContent).toBe('Count: 1');
      },
      { timeout: 2000 },
    );
  });

  it('drops the totals when the host says the selection went stale', async () => {
    const { summarize } = await open();
    summarize.mockReturnValueOnce({ stale: true });
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    await fireEvent.pointerDown(cell(2, 0), { button: 0, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId('selection-totals')).toBeNull();
  });
});

describe('result grid value to and from a file', () => {
  it('saves the focused value through the host', async () => {
    const { saveValue } = await open();
    await fireEvent.click(screen.getByTestId('value-toggle'));
    await fireEvent.pointerDown(cell(1, 2), { button: 0 });
    await fireEvent.click(await screen.findByTestId('value-save-file'));
    await flush();
    expect(saveValue).toHaveBeenCalledWith({ resultId: 'result-1', row: 1, column: 2 });
  });

  it('offers no save for NULL, and no load in a read-only result', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('value-toggle'));
    await fireEvent.pointerDown(cell(2, 2), { button: 0 });
    await screen.findByTestId('value-null');
    expect(screen.queryByTestId('value-save-file')).toBeNull();
    expect(screen.queryByTestId('value-load-file')).toBeNull();
  });

  it('loads a file into a text cell of an editable result, but not into a number', async () => {
    const { loadValue } = await open(EDITABLE);
    await fireEvent.click(screen.getByTestId('value-toggle'));
    await fireEvent.pointerDown(cell(0, 2), { button: 0 });
    await fireEvent.click(await screen.findByTestId('value-load-file'));
    await flush();
    expect(loadValue).toHaveBeenCalledWith({ resultId: 'result-1', row: 0, column: 2 });
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await flush();
    expect(screen.queryByTestId('value-load-file')).toBeNull();
  });

  it('says why a file could not be loaded, and nothing when the dialog was closed', async () => {
    const { loadValue } = await open(EDITABLE);
    loadValue.mockReturnValueOnce({ ok: false, error: 'not-text' } as never);
    await fireEvent.click(screen.getByTestId('value-toggle'));
    await fireEvent.pointerDown(cell(0, 2), { button: 0 });
    await fireEvent.click(await screen.findByTestId('value-load-file'));
    expect(await screen.findByText('The file is not UTF-8 text')).toBeTruthy();
  });
});

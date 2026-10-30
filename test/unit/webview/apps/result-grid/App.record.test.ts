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
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM t',
  statement: 'SELECT * FROM t',
  columns: [{ name: 'id' }, { name: 'name' }],
  rowCount: 3,
  truncated: false,
  durationMs: 1,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
  edit: {
    editable: true,
    columns: [
      { dataType: 'int', kind: 'integer', nullable: false },
      { dataType: 'text', kind: 'text', nullable: true },
    ],
  },
};

const ROWS = [
  [1, 'alice'],
  [2, 'bob'],
  [3, 'carol'],
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
  const edits = vi.fn((_: unknown) => ({ ok: true }));
  host.handle('editCell', edits);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [TAB], activeId: TAB.id, running: false });
  await waitFor(() => {
    expect(
      screen.queryAllByRole('gridcell').filter((item) => item.getAttribute('data-column') !== null)
        .length,
    ).toBeGreaterThan(0);
  });
  return { host, edits };
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

describe('result grid record card', () => {
  it('is closed until asked for', async () => {
    await open();
    expect(screen.queryByTestId('record-panel')).toBeNull();
  });

  it('shows the row of the selected cell and follows the selection', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('record-toggle'));
    expect(screen.getByTestId('record-empty')).toBeTruthy();
    await fireEvent.pointerDown(cell(1, 1), { button: 0 });
    await waitFor(() => {
      expect(screen.getByTestId('record-position').textContent).toBe('row 2 of 3');
    });
    expect(screen.getByDisplayValue('bob')).toBeTruthy();
    await fireEvent.pointerDown(cell(2, 0), { button: 0 });
    await waitFor(() => {
      expect(screen.getByDisplayValue('carol')).toBeTruthy();
    });
  });

  it('toggles with Shift+F4 and does not open together with the value panel', async () => {
    await open();
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'F4', shiftKey: true });
    expect(screen.getByTestId('record-panel')).toBeTruthy();
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'F4' });
    expect(screen.queryByTestId('record-panel')).toBeNull();
    expect(screen.getByTestId('value-panel')).toBeTruthy();
    await fireEvent.click(screen.getByTestId('record-toggle'));
    expect(screen.queryByTestId('value-panel')).toBeNull();
    expect(screen.getByTestId('record-panel')).toBeTruthy();
  });

  it('steps through the rows and keeps the column that was focused', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('record-toggle'));
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await waitFor(() => {
      expect(screen.getByTestId('record-position').textContent).toBe('row 1 of 3');
    });
    await fireEvent.click(screen.getByTestId('record-next'));
    await waitFor(() => {
      expect(screen.getByTestId('record-position').textContent).toBe('row 2 of 3');
    });
    await fireEvent.click(screen.getByTestId('record-next'));
    await waitFor(() => {
      expect(screen.getByTestId('record-position').textContent).toBe('row 3 of 3');
    });
    expect(screen.getByTestId<HTMLButtonElement>('record-next').disabled).toBe(true);
    await fireEvent.click(screen.getByTestId('record-previous'));
    await waitFor(() => {
      expect(screen.getByTestId('record-position').textContent).toBe('row 2 of 3');
    });
    expect(screen.getByDisplayValue('bob')).toBeTruthy();
  });

  it('edits a field through the same request the grid uses', async () => {
    const { edits } = await open();
    await fireEvent.click(screen.getByTestId('record-toggle'));
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    const area = await screen.findByDisplayValue('alice');
    await fireEvent.input(area, { target: { value: 'alicia' } });
    await fireEvent.keyDown(area, { key: 'Enter' });
    await waitFor(() => {
      expect(edits).toHaveBeenCalledWith({
        resultId: 'result-1',
        row: 0,
        column: 1,
        input: { kind: 'text', text: 'alicia' },
      });
    });
  });
});

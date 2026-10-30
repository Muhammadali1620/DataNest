import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { LinkError } from '../../../../../src/shared/link-error';
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
  title: 'SELECT * FROM items',
  statement: 'SELECT * FROM items',
  columns: [{ name: 'id' }, { name: 'order_id' }, { name: 'note' }],
  rowCount: 2,
  truncated: false,
  durationMs: 1,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
  links: [{ id: 3, columns: [1], target: 'orders' }],
  edit: {
    editable: true,
    columns: [
      { dataType: 'int', kind: 'integer', nullable: false },
      { dataType: 'int', kind: 'integer', nullable: true },
      { dataType: 'text', kind: 'text', nullable: true },
    ],
  },
};

const ROWS = [
  [1, 42, 'a'],
  [2, null, 'b'],
];

async function open(reply: { ok: boolean; error?: LinkError } = { ok: true }) {
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
  const follow = vi.fn((_: unknown) => reply);
  host.handle('followLink', follow);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [TAB], activeId: TAB.id, running: false });
  await waitFor(() => {
    expect(
      screen.queryAllByRole('gridcell').filter((item) => item.getAttribute('data-column') !== null)
        .length,
    ).toBeGreaterThan(0);
  });
  return { follow };
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

describe('result grid foreign key links', () => {
  it('marks the cells of a key column that have a value, and only those', async () => {
    await open();
    expect(cell(0, 1).classList.contains('link')).toBe(true);
    expect(cell(0, 1).getAttribute('title')).toBe('Ctrl+click or F12: open the row in orders');
    expect(cell(1, 1).classList.contains('link')).toBe(false);
    expect(cell(0, 0).classList.contains('link')).toBe(false);
    expect(cell(0, 2).classList.contains('link')).toBe(false);
  });

  it('opens the related row on Ctrl+click, with the link the host named', async () => {
    const { follow } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0, ctrlKey: true });
    await waitFor(() => {
      expect(follow).toHaveBeenCalledWith({ resultId: 'result-1', row: 0, link: 3 });
    });
  });

  it('opens it on Cmd+click too, and on F12 for the focused cell', async () => {
    const { follow } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0, metaKey: true });
    await waitFor(() => {
      expect(follow).toHaveBeenCalledTimes(1);
    });
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'F12' });
    await waitFor(() => {
      expect(follow).toHaveBeenCalledTimes(2);
    });
  });

  it('only selects on a plain click', async () => {
    const { follow } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await flush();
    expect(follow).not.toHaveBeenCalled();
    expect(cell(0, 1).classList.contains('focused')).toBe(true);
  });

  it('does nothing for a NULL cell, a cell that is not a key, or F12 there', async () => {
    const { follow } = await open();
    await fireEvent.pointerDown(cell(1, 1), { button: 0, ctrlKey: true });
    await fireEvent.pointerDown(cell(0, 2), { button: 0, ctrlKey: true });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'F12' });
    await flush();
    expect(follow).not.toHaveBeenCalled();
  });

  it('says why the host refused', async () => {
    await open({ ok: false, error: 'no-such-row' });
    await fireEvent.pointerDown(cell(0, 1), { button: 0, ctrlKey: true });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The row is gone; run the query again',
    );
  });

  it('offers the link in the record card', async () => {
    const { follow } = await open();
    await fireEvent.click(screen.getByTestId('record-toggle'));
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    const button = await screen.findByTestId('record-follow');
    expect(button.textContent).toContain('orders');
    await fireEvent.click(button);
    await waitFor(() => {
      expect(follow).toHaveBeenCalledWith({ resultId: 'result-1', row: 0, link: 3 });
    });
  });

  it('offers no link for a null key in the record card', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('record-toggle'));
    await fireEvent.pointerDown(cell(1, 0), { button: 0 });
    await screen.findByTestId('record-position');
    expect(screen.queryByTestId('record-follow')).toBeNull();
  });
});

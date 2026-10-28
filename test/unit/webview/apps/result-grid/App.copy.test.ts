import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { CopyError } from '../../../../../src/shared/copy-format';
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
  columns: [{ name: 'id' }, { name: 'name' }, { name: 'note' }],
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
      { dataType: 'text', kind: 'text', nullable: true },
      { dataType: 'text', kind: 'text', nullable: true },
    ],
  },
};

async function open(
  tab: ResultTab = TAB,
  reply: { ok: boolean; error?: CopyError; rows?: number } = { ok: true, rows: 2 },
) {
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
    rows: [
      [1, 'a', 'x'],
      [2, 'b', 'y'],
      [3, 'c', 'z'],
    ],
    rowCount: 3,
    changes: [],
    states: [],
  }));
  const copy = vi.fn((_: unknown) => reply);
  host.handle('copyAs', copy);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [tab], activeId: tab.id, running: false });
  await waitFor(() => {
    expect(
      screen
        .queryAllByRole('gridcell')
        .filter((item) => item.getAttribute('aria-colindex') !== null).length,
    ).toBeGreaterThan(0);
  });
  return { host, copy };
}

function cell(row: number, column: number): HTMLElement {
  const found = screen
    .queryAllByRole('gridcell')
    .filter((item) => item.getAttribute('aria-colindex') === String(column + 1))[row];
  if (found === undefined) {
    throw new Error(`no cell at ${row},${column}`);
  }
  return found;
}

const menu = (): HTMLSelectElement => screen.getByTestId('copy-as');

describe('result grid "Copy as"', () => {
  it('copies the whole result when nothing is selected', async () => {
    const { copy } = await open();
    await fireEvent.change(menu(), { target: { value: 'markdown' } });
    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith({ resultId: 'result-1', format: 'markdown' });
    });
  });

  it('copies the selected rectangle', async () => {
    const { copy } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.pointerEnter(cell(1, 2), { buttons: 1 });
    await fireEvent.pointerMove(cell(1, 2), { buttons: 1 });
    await fireEvent.pointerUp(cell(1, 2));
    await fireEvent.change(menu(), { target: { value: 'json' } });
    await waitFor(() => {
      expect(copy).toHaveBeenCalledOnce();
    });
    const sent = copy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ resultId: 'result-1', format: 'json', top: 0, columns: [1, 2] });
  });

  it('says how many rows were copied', async () => {
    await open();
    await fireEvent.change(menu(), { target: { value: 'csv' } });
    expect((await screen.findByTestId('copy-note')).textContent).toBe('Copied 2 rows');
  });

  it('forgets the note when the selection changes', async () => {
    await open();
    await fireEvent.change(menu(), { target: { value: 'csv' } });
    await screen.findByTestId('copy-note');
    await fireEvent.pointerDown(cell(2, 0), { button: 0 });
    await waitFor(() => {
      expect(screen.queryByTestId('copy-note')).toBeNull();
    });
  });

  it('explains a refusal in words', async () => {
    await open(TAB, { ok: false, error: 'no-key' });
    await fireEvent.change(menu(), { target: { value: 'insert' } });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'UPDATE needs a result that is one table with a key',
    );
  });

  it('offers UPDATE only for an editable result', async () => {
    const closed = await open();
    const update = (): HTMLOptionElement => screen.getByRole('option', { name: 'SQL UPDATE' });
    expect(update().disabled).toBe(true);
    expect(closed.copy).not.toHaveBeenCalled();
  });

  it('enables UPDATE when rows can be edited', async () => {
    await open(EDITABLE);
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'SQL UPDATE' }).disabled).toBe(
      false,
    );
  });

  it('lists every format', async () => {
    await open();
    const labels = [...menu().querySelectorAll('option')].map((option) =>
      option.textContent.trim(),
    );
    expect(labels).toEqual([
      'Copy as…',
      'Text with headers',
      'CSV',
      'JSON',
      'Markdown table',
      'SQL INSERT',
      'SQL UPDATE',
      'IN (…) list',
    ]);
  });

  it('is not offered for a failed result', async () => {
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
    render(App, { props: { rpc, t: createTranslator('en') } });
    await flush();
    host.emit('state', {
      tabs: [{ ...TAB, columns: [], error: { code: 'syntax', message: 'bad' } }],
      activeId: 'result-1',
      running: false,
    });
    await screen.findByTestId('error');
    expect(screen.queryByTestId('copy-as')).toBeNull();
  });
});

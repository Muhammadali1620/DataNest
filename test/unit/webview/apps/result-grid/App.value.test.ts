import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { base64Of, hexOf } from '../../../../helpers/bytes';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM docs',
  statement: 'SELECT * FROM docs',
  columns: [{ name: 'id' }, { name: 'body', dataType: 'json' }, { name: 'logo', dataType: 'blob' }],
  rowCount: 2,
  truncated: false,
  durationMs: 1,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7];

const ROWS: CellValue[][] = [
  [1, { kind: 'json', text: '{"a":1}' }, { kind: 'binary', size: 9000, preview: hexOf(PNG) }],
  [2, null, null],
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
  const bytes = vi.fn(
    (_: { resultId: string; row: number; column: number }): { size: number; data?: string } => ({
      size: 9000,
      data: base64Of(PNG),
    }),
  );
  host.handle('binaryBytes', bytes);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [TAB], activeId: TAB.id, running: false });
  await waitFor(() => {
    expect(screen.queryAllByRole('gridcell').length).toBeGreaterThan(0);
  });
  return { host, bytes };
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

describe('result grid value panel', () => {
  it('is closed until asked for', async () => {
    await open();
    expect(screen.queryByTestId('value-panel')).toBeNull();
    expect(screen.getByTestId('value-toggle')).toBeTruthy();
  });

  it('opens from the button and follows the selected cell', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('value-toggle'));
    expect(screen.getByTestId('value-empty')).toBeTruthy();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await waitFor(() => {
      expect(screen.getByTestId('value-text').textContent).toBe('{\n  "a": 1\n}');
    });
    expect(screen.getByText('json')).toBeTruthy();
    await fireEvent.pointerDown(cell(1, 1), { button: 0 });
    await waitFor(() => {
      expect(screen.getByTestId('value-null')).toBeTruthy();
    });
  });

  it('toggles with F4 and closes with its own button', async () => {
    await open();
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'F4' });
    expect(screen.getByTestId('value-panel')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('value-panel')).toBeNull();
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'F4' });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'F4' });
    expect(screen.queryByTestId('value-panel')).toBeNull();
  });

  it('asks the host for the bytes of the focused blob and shows the image', async () => {
    const { bytes } = await open();
    await fireEvent.click(screen.getByTestId('value-toggle'));
    await fireEvent.pointerDown(cell(0, 2), { button: 0 });
    const image = await screen.findByTestId('value-image');
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${base64Of(PNG)}`);
    expect(bytes).toHaveBeenCalledWith({ resultId: 'result-1', row: 0, column: 2 });
  });

  it('does not ask the host for text or NULL cells', async () => {
    const { bytes } = await open();
    await fireEvent.click(screen.getByTestId('value-toggle'));
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    await fireEvent.pointerDown(cell(1, 2), { button: 0 });
    await flush();
    expect(bytes).not.toHaveBeenCalled();
  });

  it('sends the copied value to the host', async () => {
    const { host } = await open();
    const copied = vi.fn();
    host.on('copyText', copied);
    await fireEvent.click(screen.getByTestId('value-toggle'));
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.click(await screen.findByTestId('value-copy'));
    await waitFor(() => {
      expect(copied).toHaveBeenCalledWith({ text: '{\n  "a": 1\n}' });
    });
  });
});

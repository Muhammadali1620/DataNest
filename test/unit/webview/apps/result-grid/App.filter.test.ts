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

const TABLE: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM "orders"',
  statement: 'SELECT * FROM "orders"',
  columns: [{ name: 'id' }, { name: 'status' }],
  rowCount: 2,
  truncated: false,
  durationMs: 1,
  page: { offset: 0, pageSize: 100, totalRows: 2 },
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
};

async function open(tab: ResultTab = TABLE) {
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
    rows: [[1, 'new']],
    rowCount: 1,
    changes: [],
    states: [],
  }));
  const filters = vi.fn((params: { resultId: string }) => ({
    resultId: params.resultId,
    applied: true,
  }));
  host.handle('filterTable', filters);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [tab], activeId: tab.id, running: false });
  await waitFor(() => {
    expect(screen.getByTestId('filter-toggle')).toBeTruthy();
  });
  return { host, filters };
}

describe('result grid filter', () => {
  it('is offered for a table view only', async () => {
    const { page: _page, ...plain } = TABLE;
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
    render(App, { props: { rpc, t: createTranslator('en') } });
    await flush();
    host.emit('state', { tabs: [plain], activeId: plain.id, running: false });
    await flush();
    expect(screen.queryByTestId('filter-toggle')).toBeNull();
  });

  it('opens a bar and sends what is typed to the host', async () => {
    const { filters } = await open();
    expect(screen.queryByTestId('filter-bar')).toBeNull();
    await fireEvent.click(screen.getByTestId('filter-toggle'));
    await fireEvent.click(screen.getByTestId('filter-add'));
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'new' } });
    await fireEvent.click(screen.getByTestId('filter-apply'));
    await waitFor(() => {
      expect(filters).toHaveBeenCalledWith({
        resultId: 'result-1',
        filter: { conditions: [{ column: 'id', operator: 'eq', value: 'new' }] },
      });
    });
  });

  it('sends null when the filter is cleared', async () => {
    const { filters } = await open({
      ...TABLE,
      filter: { conditions: [{ column: 'id', operator: 'isNull' }] },
    });
    expect(screen.getByTestId('filter-toggle').textContent).toContain('(1)');
    await fireEvent.click(screen.getByTestId('filter-toggle'));
    await fireEvent.click(screen.getByTestId('filter-clear'));
    await waitFor(() => {
      expect(filters).toHaveBeenCalledWith({ resultId: 'result-1', filter: null });
    });
  });

  it('keeps the bar, with the column list, when the filtered read failed', async () => {
    const { host } = await open();
    await fireEvent.click(screen.getByTestId('filter-toggle'));
    host.emit('state', {
      tabs: [
        TABLE,
        {
          ...TABLE,
          id: 'result-2',
          columns: [],
          error: { code: 'syntax', message: 'bad where' },
          filter: { conditions: [], where: 'a = ' },
        },
      ],
      activeId: 'result-2',
      running: false,
    });
    expect(await screen.findByTestId('error')).toBeTruthy();
    expect(screen.getByTestId('filter-bar')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>('filter-where').value).toBe('a = ');
    await fireEvent.click(screen.getByTestId('filter-add'));
    // The columns of the last good read are still offered.
    expect(screen.getByLabelText('Column').tagName).toBe('SELECT');
  });

  it('shows the filter of a newly applied result, not the old draft', async () => {
    const { host } = await open();
    await fireEvent.click(screen.getByTestId('filter-toggle'));
    host.emit('state', {
      tabs: [TABLE, { ...TABLE, id: 'result-2', filter: { conditions: [], where: 'status = 1' } }],
      activeId: 'result-2',
      running: false,
    });
    await waitFor(() => {
      expect(screen.getByTestId<HTMLInputElement>('filter-where').value).toBe('status = 1');
    });
  });
});

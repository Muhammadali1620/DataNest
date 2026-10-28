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

function tab(page: NonNullable<ResultTab['page']>, rowCount = 100): ResultTab {
  return {
    id: 'result-1',
    title: 'SELECT * FROM "orders"',
    statement: 'SELECT * FROM "orders"',
    columns: [{ name: 'id' }],
    rowCount,
    truncated: false,
    durationMs: 1,
    page,
    changedCells: 0,
    insertedRows: 0,
    deletedRows: 0,
    revision: 0,
  };
}

async function open(page: NonNullable<ResultTab['page']>, rowCount = 100) {
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
    rows: [[1]],
    rowCount,
    changes: [],
    states: [],
  }));
  const reply = (params: { resultId: string }) => ({ resultId: params.resultId, applied: true });
  const pageTo = vi.fn(reply);
  const failures = { pageSize: false };
  const pageSize = vi.fn((params: { resultId: string }) => {
    if (failures.pageSize) {
      throw new Error('boom');
    }
    return reply(params);
  });
  const loadAll = vi.fn(reply);
  const countRows = vi.fn(reply);
  host.handle('pageTo', pageTo);
  host.handle('pageSize', pageSize);
  host.handle('loadAll', loadAll);
  host.handle('countRows', countRows);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  const first = tab(page, rowCount);
  host.emit('state', { tabs: [first], activeId: first.id, running: false });
  await waitFor(() => {
    expect(screen.getByTestId('pager')).toBeTruthy();
  });
  return { host, pageTo, pageSize, loadAll, countRows, failures };
}

const next = (): HTMLButtonElement => screen.getByRole('button', { name: 'Next' });
const previous = (): HTMLButtonElement => screen.getByRole('button', { name: 'Previous' });

describe('result grid pager', () => {
  it('shows the range, the page number and the page count', async () => {
    await open({ offset: 100, pageSize: 100, totalRows: 450 });
    expect(screen.getByTestId('range').textContent.trim()).toBe('rows 101–200 of 450');
    expect(screen.getByTestId<HTMLInputElement>('page-number').value).toBe('2');
    expect(screen.getByTestId('page-number').closest('label')?.textContent).toContain('of 5');
  });

  it('steps to the neighbouring pages and stops at the ends', async () => {
    const { pageTo } = await open({ offset: 100, pageSize: 100, totalRows: 450 });
    await fireEvent.click(next());
    await fireEvent.click(previous());
    await waitFor(() => {
      expect(pageTo).toHaveBeenCalledTimes(2);
    });
    expect(pageTo).toHaveBeenNthCalledWith(1, { resultId: 'result-1', offset: 200 });
    expect(pageTo).toHaveBeenNthCalledWith(2, { resultId: 'result-1', offset: 0 });
  });

  it('cannot go back from the first page or forward from the last', async () => {
    await open({ offset: 0, pageSize: 100, totalRows: 100 });
    expect(previous().disabled).toBe(true);
    expect(next().disabled).toBe(true);
  });

  it('goes to a typed page on Enter', async () => {
    const { pageTo } = await open({ offset: 0, pageSize: 100, totalRows: 450 });
    const input = screen.getByTestId<HTMLInputElement>('page-number');
    await fireEvent.input(input, { target: { value: '4' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(pageTo).toHaveBeenCalledWith({ resultId: 'result-1', offset: 300 });
    });
  });

  it('clamps a page past the end to the last one', async () => {
    const { pageTo } = await open({ offset: 0, pageSize: 100, totalRows: 450 });
    const input = screen.getByTestId<HTMLInputElement>('page-number');
    await fireEvent.input(input, { target: { value: '99' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(pageTo).toHaveBeenCalledWith({ resultId: 'result-1', offset: 400 });
    });
  });

  it('does nothing for an empty page box', async () => {
    const { pageTo } = await open({ offset: 0, pageSize: 100, totalRows: 450 });
    const input = screen.getByTestId<HTMLInputElement>('page-number');
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(pageTo).not.toHaveBeenCalled();
  });

  it('changes the page size', async () => {
    const { pageSize } = await open({ offset: 0, pageSize: 100, totalRows: 450 });
    await fireEvent.change(screen.getByTestId('page-size'), { target: { value: '500' } });
    await waitFor(() => {
      expect(pageSize).toHaveBeenCalledWith({ resultId: 'result-1', pageSize: 500 });
    });
  });

  it('lists the size in use even when it is not a usual one', async () => {
    await open({ offset: 0, pageSize: 250, totalRows: 450 });
    const options = [...screen.getByTestId('page-size').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toContain('250');
    expect(screen.getByTestId<HTMLSelectElement>('page-size').value).toBe('250');
  });

  it('loads everything on request', async () => {
    const { loadAll } = await open({ offset: 0, pageSize: 100, totalRows: 450 });
    await fireEvent.click(screen.getByTestId('load-all'));
    await waitFor(() => {
      expect(loadAll).toHaveBeenCalledWith({ resultId: 'result-1' });
    });
  });

  it('has nothing to load when the page already holds the whole table', async () => {
    await open({ offset: 0, pageSize: 1000, totalRows: 40 }, 40);
    expect(screen.getByTestId<HTMLButtonElement>('load-all').disabled).toBe(true);
  });

  it('marks an estimate and offers an exact count', async () => {
    const { countRows } = await open({
      offset: 0,
      pageSize: 100,
      totalRows: 2_500_000,
      approximate: true,
    });
    expect(screen.getByTestId('range').textContent.trim()).toBe('rows 1–100 of about 2500000');
    // Page count is unknown, so there is no "of N" and Next relies on a full page.
    expect(screen.getByTestId('page-number').closest('label')?.textContent).not.toContain('of ');
    expect(next().disabled).toBe(false);
    await fireEvent.click(screen.getByTestId('count-exactly'));
    await waitFor(() => {
      expect(countRows).toHaveBeenCalledWith({ resultId: 'result-1' });
    });
  });

  it('offers no count button for an exact total', async () => {
    await open({ offset: 0, pageSize: 100, totalRows: 450 });
    expect(screen.queryByTestId('count-exactly')).toBeNull();
  });

  it('shows only the rows when the count is unknown', async () => {
    await open({ offset: 0, pageSize: 100 });
    expect(screen.getByTestId('range').textContent.trim()).toBe('rows 1–100');
    expect(next().disabled).toBe(false);
  });

  it('shows a request failure without breaking the pager', async () => {
    const { failures } = await open({ offset: 0, pageSize: 100, totalRows: 450 });
    failures.pageSize = true;
    await fireEvent.change(screen.getByTestId('page-size'), { target: { value: '500' } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('pager')).toBeTruthy();
  });
});

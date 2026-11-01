import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const RESTORED: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM orders',
  statement: 'SELECT * FROM orders',
  columns: [],
  rowCount: 0,
  truncated: false,
  durationMs: 0,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
  restored: true,
};

const { restored: _restored, ...BASE } = RESTORED;
const LIVE: ResultTab = {
  ...BASE,
  id: 'result-2',
  title: 'SELECT 1',
  statement: 'SELECT 1',
  columns: [{ name: 'one' }],
  rowCount: 1,
  durationMs: 4,
};

async function open(tabs: ResultTab[], running = false, language: 'en' | 'ru' = 'en') {
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
  const runSql = vi.fn((_: unknown): { ok: boolean; error?: string } => ({ ok: true }));
  host.handle('runSql', runSql);
  host.handle('rows', ({ resultId, offset }) => ({
    resultId,
    offset,
    rows: [[1]],
    rowCount: 1,
    changes: [],
    states: [],
  }));
  render(App, { props: { rpc, t: createTranslator(language) } });
  await flush();
  host.emit('state', { tabs, activeId: tabs[0]?.id, running });
  await flush();
  return { host, runSql };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('a result tab that came back after a restart (V13.12)', () => {
  it('says it was not run, shows the statement and offers to run it', async () => {
    await open([RESTORED]);
    expect(await screen.findByTestId('restored')).toBeTruthy();
    expect(screen.getByText('Not run since the editor restarted')).toBeTruthy();
    expect(screen.getByTestId<HTMLTextAreaElement>('sql-input').value).toBe('SELECT * FROM orders');
    expect(screen.getByTestId('restored-run').textContent).toContain('Run');
  });

  it('shows no grid, no search and no row counts for the missing rows', async () => {
    await open([RESTORED]);
    await screen.findByTestId('restored');
    expect(screen.queryByTestId('grid')).toBeNull();
    expect(screen.getByTestId('summary').textContent).toContain('Not run yet');
    expect(screen.getByTestId('summary').textContent).not.toContain('0 rows');
  });

  it('runs the statement of the tab when the button is clicked', async () => {
    const { runSql } = await open([RESTORED]);
    await fireEvent.click(await screen.findByTestId('restored-run'));
    await waitFor(() => {
      expect(runSql).toHaveBeenCalledWith({ resultId: 'result-1', sql: 'SELECT * FROM orders' });
    });
  });

  it('waits while a statement of the file is running', async () => {
    const { runSql } = await open([RESTORED], true);
    const button = await screen.findByTestId('restored-run');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(button);
    expect(runSql).not.toHaveBeenCalled();
  });

  it('is told apart from a finished result in the tab strip', async () => {
    await open([RESTORED, LIVE]);
    await screen.findByTestId('restored');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.querySelector('.codicon-glyph')?.getAttribute('data-glyph')).not.toBe(
      tabs[1]?.querySelector('.codicon-glyph')?.getAttribute('data-glyph'),
    );
  });

  it('a finished tab beside it shows its rows as always', async () => {
    const { host } = await open([RESTORED, LIVE]);
    host.emit('state', { tabs: [RESTORED, LIVE], activeId: LIVE.id, running: false });
    await waitFor(() => {
      expect(screen.queryByTestId('restored')).toBeNull();
      expect(screen.getByTestId('grid')).toBeTruthy();
    });
  });

  it('is replaced by the result when the run is over', async () => {
    const { host } = await open([RESTORED]);
    await screen.findByTestId('restored');
    host.emit('state', {
      tabs: [{ ...LIVE, id: 'result-3' }],
      activeId: 'result-3',
      running: false,
    });
    await waitFor(() => {
      expect(screen.queryByTestId('restored')).toBeNull();
    });
  });

  it('speaks Russian', async () => {
    await open([RESTORED], false, 'ru');
    expect(await screen.findByText('Не выполнялся после перезапуска редактора')).toBeTruthy();
    expect(screen.getByTestId('restored-run').textContent).toContain('Выполнить');
    expect(screen.getByTestId('summary').textContent).toContain('Ещё не выполнен');
  });
});

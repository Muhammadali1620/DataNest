import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  dataCompareProtocol,
  type DataCompareProtocol,
  type DataCompareRow,
  type DataCompareState,
  type RowKind,
} from '../../../../../src/shared/protocols/data-compare';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/data-compare/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<DataCompareProtocol['host'], DataCompareProtocol['webview']>;

const base: DataCompareState = {
  source: 'mysql · shop.items',
  target: 'pg · public.items',
  key: [{ source: 'id', target: 'id' }],
  columns: [
    { source: 'name', target: 'name' },
    { source: 'price', target: 'price' },
  ],
  sourceOnly: [],
  targetOnly: ['extra'],
};

const done = (
  overrides: Partial<NonNullable<DataCompareState['result']>> = {},
): DataCompareState => ({
  ...base,
  result: {
    same: 7,
    different: 1,
    onlySource: 2,
    onlyTarget: 1,
    kept: { different: 1, onlySource: 2, onlyTarget: 1 },
    durationMs: 12,
    ...overrides,
  },
});

const ROWS: Record<RowKind, DataCompareRow[]> = {
  different: [
    { cells: ['3', 'milk', '2.25'], target: ['3', 'MILK', '2.25'], differs: [false, true, false] },
  ],
  onlySource: [{ cells: ['4', 'juice', null] }, { cells: ['5', 'water', '0.99'] }],
  onlyTarget: [{ cells: ['6', 'soda', '1.5'] }],
};

async function setup(initial: DataCompareState | null = done()) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: dataCompareProtocol.host,
    remote: dataCompareProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: dataCompareProtocol.webview,
    remote: dataCompareProtocol.host,
    transport: transports.webview,
  });
  const requests: { kind: RowKind; offset: number }[] = [];
  const scripts: { insert: boolean; update: boolean; delete: boolean }[] = [];
  const events = { ready: vi.fn(), refresh: vi.fn(), cancel: vi.fn() };
  host.on('ready', events.ready);
  host.on('refresh', events.refresh);
  host.on('cancel', events.cancel);
  host.handle('rows', ({ kind, offset, limit }) => {
    requests.push({ kind, offset });
    return { rows: ROWS[kind].slice(offset, offset + limit) };
  });
  host.handle('openScript', (include) => {
    scripts.push(include);
    return { opened: true };
  });
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  if (initial !== null) {
    host.emit('state', initial);
    await waitFor(() => {
      expect(screen.getByText('mysql · shop.items')).not.toBeNull();
    });
  }
  return { host, events, requests, scripts };
}

describe('data comparison page', () => {
  it('shows the progress and stops on request', async () => {
    const page = await setup(null);
    expect(page.events.ready).toHaveBeenCalled();
    page.host.emit('state', { ...base, progress: { phase: 'source', rows: 15000 } });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent.trim()).toBe('Reading the source: 15000 rows');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(page.events.cancel).toHaveBeenCalled();
    });
  });

  it('tells by what rows match and which columns only one side has', async () => {
    await setup();
    expect(screen.getByText(/Rows are matched by id\./u)).not.toBeNull();
    expect(screen.getByText(/Only in the target: extra\./u)).not.toBeNull();
    expect(screen.getByText('The same: 7 rows')).not.toBeNull();
  });

  it('opens on the rows that differ and marks the changed cells', async () => {
    const page = await setup();
    await waitFor(() => {
      expect(page.requests[0]).toEqual({ kind: 'different', offset: 0 });
    });
    await waitFor(() => {
      expect(screen.getByText('MILK')).not.toBeNull();
    });
    const cell = screen.getByText('MILK').closest('td');
    expect(cell?.classList.contains('differs')).toBe(true);
    expect(cell?.textContent).toContain('milk');
    // Only differing columns: price is the same everywhere, so it is hidden.
    expect(screen.queryByRole('columnheader', { name: 'price' })).toBeNull();
    await fireEvent.click(screen.getByLabelText('Only columns that differ'));
    expect(screen.getByRole('columnheader', { name: 'price' })).not.toBeNull();
  });

  it('switches between kinds of rows and shows NULL', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('tab', { name: 'Only in the source (2)' }));
    await waitFor(() => {
      expect(screen.getByText('juice')).not.toBeNull();
    });
    expect(screen.getByText('NULL')).not.toBeNull();
    expect(screen.getByText('Shown 2 of 2.')).not.toBeNull();
    expect(page.requests.at(-1)).toEqual({ kind: 'onlySource', offset: 0 });
  });

  it('opens on another kind when none differ, and says when there are no rows', async () => {
    const page = await setup(
      done({ different: 0, kept: { different: 0, onlySource: 2, onlyTarget: 1 } }),
    );
    await waitFor(() => {
      expect(page.requests[0]?.kind).toBe('onlySource');
    });
    await fireEvent.click(screen.getByRole('tab', { name: 'Different (0)' }));
    await waitFor(() => {
      expect(screen.getByText('No such rows.')).not.toBeNull();
    });
  });

  it('says how many rows DataNest keeps of many', async () => {
    await setup(done({ different: 20_000, kept: { different: 1, onlySource: 2, onlyTarget: 1 } }));
    await waitFor(() => {
      expect(screen.getByText(/keeps the first 1 to show and to sync/u)).not.toBeNull();
    });
  });

  it('opens the sync script of the chosen parts, deletes off at first', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Open sync script' }));
    await waitFor(() => {
      expect(page.scripts).toEqual([{ insert: true, update: true, delete: false }]);
    });
    await fireEvent.click(screen.getByLabelText('Insert missing rows (2)'));
    await fireEvent.click(screen.getByLabelText('Update rows that differ (1)'));
    expect(screen.getByRole('button', { name: 'Open sync script' }).hasAttribute('disabled')).toBe(
      true,
    );
    await fireEvent.click(screen.getByLabelText('Delete rows only in the target (1)'));
    await fireEvent.click(screen.getByRole('button', { name: 'Open sync script' }));
    await waitFor(() => {
      expect(page.scripts.at(-1)).toEqual({ insert: false, update: false, delete: true });
    });
  });

  it('compares again and shows an error', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Compare again' }));
    await waitFor(() => {
      expect(page.events.refresh).toHaveBeenCalled();
    });
    page.host.emit('state', { ...base, error: 'Values of the key columns repeat in the target' });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('repeat in the target');
    });
  });
});

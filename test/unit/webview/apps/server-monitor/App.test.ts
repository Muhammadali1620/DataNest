import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type MonitorProcess,
  type MonitorStatusRow,
  type MonitorScope,
  serverMonitorProtocol,
  type ServerMonitorProtocol,
  type ServerMonitorState,
} from '../../../../../src/shared/protocols/server-monitor';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/server-monitor/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ServerMonitorProtocol['host'], ServerMonitorProtocol['webview']>;

const STATE: ServerMonitorState = {
  connectionName: 'Local MySQL',
  server: 'MySQL',
  features: {
    processes: true,
    cancel: true,
    terminate: true,
    scopes: ['session', 'server'],
    serverScope: 'global',
  },
  readOnly: false,
};

const PROCESSES: MonitorProcess[] = [
  {
    id: '7',
    user: 'app',
    host: 'web1',
    database: 'shop',
    state: 'Query · executing',
    seconds: 12,
    query: 'SELECT SLEEP(30)',
    idle: false,
    mine: false,
  },
  { id: '8', user: 'app', state: 'Sleep', seconds: 300, idle: true, mine: false },
  {
    id: '9',
    user: 'me',
    state: 'Query',
    seconds: 0,
    query: 'SHOW PROCESSLIST',
    idle: false,
    mine: true,
  },
  {
    id: '10',
    user: 'batch',
    state: 'Query · Waiting for lock',
    seconds: 125,
    query: 'UPDATE stock SET n = 0',
    idle: false,
    mine: false,
    blockedBy: '7',
  },
];

interface Setup {
  host: HostPeer;
  calls: {
    processes: number;
    status: number;
    settings: MonitorScope[];
    stop: { id: string; kind: string }[];
  };
}

async function setup(
  state: ServerMonitorState = STATE,
  options: {
    stopped?: boolean;
    failProcesses?: string;
    /** The status rows of reading number `call` (1, 2, …), for the charts. */
    statusRows?: (call: number) => MonitorStatusRow[];
  } = {},
): Promise<Setup> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: serverMonitorProtocol.host,
    remote: serverMonitorProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: serverMonitorProtocol.webview,
    remote: serverMonitorProtocol.host,
    transport: transports.webview,
  });
  const calls: Setup['calls'] = { processes: 0, status: 0, settings: [], stop: [] };
  host.handle('processes', () => {
    calls.processes += 1;
    if (options.failProcesses !== undefined) {
      throw new Error(options.failProcesses);
    }
    return { rows: PROCESSES, at: 0 };
  });
  host.handle('status', () => {
    calls.status += 1;
    const call = calls.status;
    return {
      rows: options.statusRows?.(call) ?? [
        { name: 'Questions', value: '1200', perSecond: 12.5 },
        { name: 'Uptime', value: '3600' },
        { name: 'Query', value: '3', group: 'events' },
      ],
      summary: {
        version: '8.4.6',
        uptimeSeconds: 3725,
        connections: 4,
        maxConnections: 151,
        rate: { kind: 'queries', perSecond: 12.5 },
      },
      at: call * 3000,
    };
  });
  host.handle('settings', ({ scope }) => {
    calls.settings.push(scope);
    return {
      rows:
        scope === 'session'
          ? [
              { name: 'autocommit', value: 'ON' },
              {
                name: 'sort_buffer_size',
                value: '262144',
                unit: 'B',
                description: 'Buffer for sorts',
                changed: true,
              },
            ]
          : [{ name: 'max_connections', value: '151' }],
    };
  });
  host.handle('stop', ({ id, kind }) => {
    calls.stop.push({ id, kind });
    return { stopped: options.stopped ?? true };
  });
  host.on('ready', () => {
    host.emit('state', state);
  });
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  await screen.findByRole('heading', { level: 1 });
  return { host, calls };
}

function processRows(): string[] {
  const table = screen.getByTestId('processes');
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('td')?.textContent.trim() ?? '');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('server monitor page', () => {
  it('shows the server, its numbers and the busy processes, longest first', async () => {
    const { calls } = await setup();
    await waitFor(() => {
      expect(processRows()).toEqual(['10', '7', '9(this page)']);
    });
    expect(calls.status).toBe(1);
    expect(screen.getByTestId('server').textContent).toBe('MySQL 8.4.6');
    const cards = screen.getByTestId('cards').textContent;
    for (const part of ['1:02:05', '4 / 151', '12.5']) {
      expect(cards).toContain(part);
    }
    expect(screen.getByRole('tab', { name: 'Processes (4)' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('blocked by 7')).toBeTruthy();
    expect(screen.getByText('2:05')).toBeTruthy();
  });

  it('shows idle sessions on request and filters by any text', async () => {
    await setup();
    await waitFor(() => {
      expect(processRows()).toHaveLength(3);
    });
    await fireEvent.click(screen.getByLabelText('Hide idle'));
    expect(processRows()).toEqual(['8', '10', '7', '9(this page)']);
    await fireEvent.input(screen.getByLabelText('Filter'), { target: { value: 'stock' } });
    expect(processRows()).toEqual(['10']);
    await fireEvent.input(screen.getByLabelText('Filter'), {
      target: { value: 'nothing like it' },
    });
    expect(screen.getByText('Nothing matches the filter.')).toBeTruthy();
  });

  it('sorts by a column on click, and back on a second click', async () => {
    await setup();
    await waitFor(() => {
      expect(processRows()).toHaveLength(3);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(processRows()).toEqual(['7', '10', '9(this page)']);
    await fireEvent.click(screen.getByRole('button', { name: /User/u }));
    expect(processRows()).toEqual(['9(this page)', '10', '7']);
  });

  it('shows the whole statement of the chosen process and stops it', async () => {
    const { calls } = await setup();
    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel statement' });
    const end = screen.getByRole('button', { name: 'End session' });
    expect(cancel.disabled).toBe(true);
    await waitFor(() => {
      expect(processRows()).toHaveLength(3);
    });
    await fireEvent.click(screen.getByText('UPDATE stock SET n = 0', { selector: 'td' }));
    expect(screen.getByTestId('details').textContent).toContain('UPDATE stock SET n = 0');
    expect(cancel.disabled).toBe(false);
    await fireEvent.click(end);
    await waitFor(() => {
      expect(calls.stop).toEqual([{ id: '10', kind: 'terminate' }]);
    });
    // The list is read again after a stop.
    await waitFor(() => {
      expect(calls.processes).toBe(2);
    });
  });

  it('never stops its own session, and nothing on a read-only connection', async () => {
    await setup();
    await waitFor(() => {
      expect(processRows()).toHaveLength(3);
    });
    await fireEvent.click(screen.getByText('SHOW PROCESSLIST', { selector: 'td' }));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel statement' }).disabled,
    ).toBe(true);
  });

  it('says why nothing can be stopped on a read-only connection', async () => {
    await setup({ ...STATE, readOnly: true });
    await waitFor(() => {
      expect(processRows()).toHaveLength(3);
    });
    await fireEvent.click(screen.getByText('SELECT SLEEP(30)', { selector: 'td' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'End session' }).disabled).toBe(
      true,
    );
    expect(screen.getByText(/read-only/u)).toBeTruthy();
  });

  it('offers only the ways the server can stop a process', async () => {
    await setup({
      ...STATE,
      features: {
        processes: true,
        cancel: false,
        terminate: true,
        scopes: ['session'],
        serverScope: 'server',
      },
    });
    expect(screen.queryByRole('button', { name: 'Cancel statement' })).toBeNull();
    expect(screen.getByRole('button', { name: 'End session' })).toBeTruthy();
  });

  it('shows the error of a failed read on its tab', async () => {
    await setup(STATE, { failProcesses: 'Access denied; you need the PROCESS privilege' });
    expect((await screen.findByRole('alert')).textContent).toContain('PROCESS privilege');
  });

  it('reads settings of either scope, with units and the changed ones', async () => {
    const { calls } = await setup();
    await fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings').textContent).toContain('262144 B');
    });
    expect(screen.getByText('Buffer for sorts')).toBeTruthy();
    await fireEvent.click(screen.getByLabelText('Only changed from the default'));
    expect(screen.queryByText('autocommit')).toBeNull();
    await fireEvent.click(screen.getByLabelText('Global'));
    await waitFor(() => {
      expect(screen.getByTestId('settings').textContent).toContain('max_connections');
    });
    expect(calls.settings).toEqual(['session', 'server']);
    // Back to the tab: settings stay as read, not asked again.
    await fireEvent.click(screen.getByRole('tab', { name: 'Status' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    expect(calls.settings).toHaveLength(2);
  });

  it('shows the status with groups and changes per second', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('tab', { name: 'Status' }));
    const table = await screen.findByTestId('status');
    await waitFor(() => {
      expect(table.textContent).toContain('+12.5');
    });
    expect(table.textContent).toContain('events');
    await fireEvent.click(screen.getByLabelText('Only changing'));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('opens on the settings where the server has no processes', async () => {
    const { calls } = await setup({
      connectionName: 'file.db',
      server: 'SQLite',
      features: {
        processes: false,
        cancel: false,
        terminate: false,
        scopes: ['session'],
        serverScope: 'server',
      },
      readOnly: false,
    });
    expect(screen.queryByRole('tab', { name: /Processes/u })).toBeNull();
    await waitFor(() => {
      expect(calls.settings).toEqual(['session']);
    });
    expect(calls.processes).toBe(0);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('shows why the monitor could not start', async () => {
    await setup({
      connectionName: 'Broken',
      readOnly: false,
      error: 'password authentication failed',
    });
    expect(screen.getByRole('alert').textContent).toBe('password authentication failed');
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('reads again on its own at the chosen interval, until Auto is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { calls } = await setup();
    await vi.waitFor(() => {
      expect(calls.processes).toBe(1);
    });
    await fireEvent.change(screen.getByLabelText('Refresh interval'), { target: { value: '2' } });
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => {
      expect(calls.processes).toBe(2);
      expect(calls.status).toBe(2);
    });
    expect(screen.getByTestId('auto-state').textContent.trim()).toBe('Refreshing every 2 s');
    await fireEvent.click(screen.getByRole('button', { name: 'Pause auto refresh' }));
    expect(screen.getByTestId('auto-state').textContent.trim()).toBe('Auto refresh is paused');
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(calls.processes).toBe(2);
    // Resumed, it reads again at the interval.
    await fireEvent.click(screen.getByRole('button', { name: 'Resume auto refresh' }));
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => {
      expect(calls.processes).toBe(3);
    });
  });

  it('draws the trend of the rate once two readings are in', async () => {
    const { calls } = await setup();
    await vi.waitFor(() => {
      expect(calls.status).toBe(1);
    });
    expect(screen.queryByTestId('trend')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      // The same rate twice: a level line at the height of the highest reading.
      expect(screen.getByTestId('trend').querySelector('polyline')?.getAttribute('points')).toBe(
        '0,1 120,1',
      );
    });
    expect(screen.getByTestId('trend').getAttribute('aria-hidden')).toBe('true');
  });

  it('marks the changed settings in words for screen readers too', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const table = await screen.findByTestId('settings');
    await waitFor(() => {
      expect(table.textContent).toContain('sort_buffer_size');
    });
    const changed = within(table).getByText('Changed from the default');
    expect(changed.closest('tr')?.textContent).toContain('sort_buffer_size');
    expect(within(table).getAllByText('Changed from the default')).toHaveLength(1);
  });

  describe('charts', () => {
    const POSTGRES = (call: number): MonitorStatusRow[] => {
      const rate = call > 1;
      return [
        {
          name: 'blks_read',
          value: '10',
          group: 'pg_stat_database',
          ...(rate ? { perSecond: 2 } : {}),
        },
        {
          name: 'blks_hit',
          value: '90',
          group: 'pg_stat_database',
          ...(rate ? { perSecond: 10 } : {}),
        },
        {
          name: 'tup_inserted',
          value: '5',
          group: 'pg_stat_database',
          ...(rate ? { perSecond: 1 } : {}),
        },
        { name: 'tup_updated', value: '5', group: 'pg_stat_database' },
        { name: 'tup_deleted', value: '5', group: 'pg_stat_database' },
        {
          name: 'tup_returned',
          value: '5',
          group: 'pg_stat_database',
          ...(rate ? { perSecond: 4 } : {}),
        },
        {
          name: 'tup_fetched',
          value: '5',
          group: 'pg_stat_database',
          ...(rate ? { perSecond: 3 } : {}),
        },
      ];
    };

    async function openStatus(rows: (call: number) => MonitorStatusRow[]): Promise<Setup> {
      const made = await setup(STATE, { statusRows: rows });
      await fireEvent.click(screen.getByRole('tab', { name: 'Status' }));
      await screen.findByTestId('status');
      return made;
    }

    it('shows both charts on the status tab, after the cards and before the table', async () => {
      await openStatus(POSTGRES);
      const charts = screen.getByTestId('charts');
      expect(within(charts).getAllByTestId('chart')).toHaveLength(2);
      expect(
        charts.compareDocumentPosition(screen.getByTestId('status')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('draws Traffic and Queries with their legends once readings arrive', async () => {
      const { calls } = await openStatus(POSTGRES);
      await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => {
        expect(calls.status).toBeGreaterThanOrEqual(3);
      });
      const [traffic, queries] = screen.getAllByTestId('chart');
      expect(traffic?.textContent).toContain('Traffic');
      expect(traffic?.textContent).toContain('read');
      expect(traffic?.textContent).toContain('hit');
      expect(queries?.textContent).toContain('Queries');
      for (const word of ['insert', 'update', 'delete', 'select', 'fetched']) {
        expect(queries?.textContent).toContain(word);
      }
      expect(traffic?.querySelectorAll('path.line')).toHaveLength(2);
      expect(queries?.querySelectorAll('path.line')).toHaveLength(5);
      // Blocks of 8 KB: 10 blocks a second is 80 KB.
      expect(traffic?.querySelector('table')?.textContent).toContain('80.0 KB');
    });

    it('has the same counters for MySQL', async () => {
      await openStatus((call) => [
        { name: 'Bytes_received', value: '1', ...(call > 1 ? { perSecond: 500 } : {}) },
        { name: 'Bytes_sent', value: '1', ...(call > 1 ? { perSecond: 900 } : {}) },
        { name: 'Com_select', value: '1', ...(call > 1 ? { perSecond: 3 } : {}) },
        { name: 'Com_insert', value: '1' },
      ]);
      expect(screen.getAllByTestId('chart')).toHaveLength(2);
      expect(screen.getAllByTestId('chart')[0]?.textContent).toContain('received');
    });

    it('draws no charts for a server whose counters are not known', async () => {
      await openStatus(() => [{ name: 'Questions', value: '1200', perSecond: 12.5 }]);
      expect(screen.queryByTestId('charts')).toBeNull();
    });
  });
});

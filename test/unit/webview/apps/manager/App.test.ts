import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ManagerDumpOptions,
  type ManagerLogEntry,
  managerProtocol,
  type ManagerProtocol,
  type ManagerState,
} from '../../../../../src/shared/protocols/manager';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/manager/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ManagerProtocol['host'], ManagerProtocol['webview']>;

const STATE: ManagerState = {
  connectionId: 'c1',
  connectionName: 'Local PG',
  driver: 'postgres',
  sections: ['log', 'dashboard', 'processes', 'dump', 'sync'],
  section: 'log',
  database: 'shop',
  schema: 'public',
  readOnly: false,
  production: false,
};

const AT = new Date(2026, 9, 31, 14, 5, 9).getTime();

const LOG: ManagerLogEntry[] = [
  { id: '1', at: AT, sql: 'SELECT * FROM users', ok: true, durationMs: 12, rows: 3, runs: 1 },
  {
    id: '2',
    at: AT + 1000,
    sql: 'DELETE FROM orders',
    ok: true,
    durationMs: 4,
    affected: 2,
    runs: 3,
  },
  {
    id: '3',
    at: AT + 2000,
    sql: 'DROP TABLE x',
    ok: false,
    durationMs: 1500,
    error: 'permission denied',
    runs: 1,
  },
];

const DUMP_OPTIONS: ManagerDumpOptions = {
  databases: ['shop', 'blog'],
  database: 'shop',
  schemas: ['public'],
  schema: 'public',
  relations: [
    { name: 'orders', kind: 'table' },
    { name: 'users', kind: 'table' },
    { name: 'v_sales', kind: 'view' },
  ],
  ticked: ['orders', 'users', 'v_sales'],
  output: '/work/shop-2026-10-31-1405.sql',
};

interface Setup {
  host: HostPeer;
  calls: {
    clear: number;
    optionRequests: { database?: string | undefined; schema?: string | undefined }[];
    runs: unknown[];
    reveal: { path: string; how: string }[];
    cancels: number;
    syncStarts: unknown[];
    scopes: { connectionId: string; database?: string | undefined }[];
    monitor: string[];
  };
}

async function setup(
  options: {
    state?: ManagerState;
    log?: ManagerLogEntry[];
    clear?: boolean;
    runFails?: string;
    startFails?: string;
    skipped?: string[];
    hold?: boolean;
  } = {},
): Promise<Setup> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: managerProtocol.host,
    remote: managerProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: managerProtocol.webview,
    remote: managerProtocol.host,
    transport: transports.webview,
  });
  const calls: Setup['calls'] = {
    clear: 0,
    optionRequests: [],
    runs: [],
    reveal: [],
    cancels: 0,
    syncStarts: [],
    scopes: [],
    monitor: [],
  };
  let log = options.log ?? LOG;
  host.handle('log.list', () => ({ entries: log }));
  host.handle('log.clear', () => {
    calls.clear += 1;
    if (options.clear === true) {
      log = [];
    }
    return { cleared: options.clear === true };
  });
  host.handle('dump.options', (picked) => {
    calls.optionRequests.push(picked);
    return picked.database === 'blog'
      ? {
          ...DUMP_OPTIONS,
          database: 'blog',
          relations: [{ name: 'posts', kind: 'table' }],
          ticked: ['posts'],
        }
      : DUMP_OPTIONS;
  });
  host.handle('dump.browse', () => ({ output: '/elsewhere/dump.sql' }));
  host.handle('dump.run', async (request) => {
    calls.runs.push(request);
    host.emit('dump.progress', { table: 'orders', rows: 10, tablesDone: 1, tablesTotal: 4 });
    if (options.hold === true) {
      await new Promise(() => undefined);
    }
    if (options.runFails !== undefined) {
      throw new Error(options.runFails);
    }
    return {
      path: request.output,
      bytes: 2048,
      tables: 2,
      views: 1,
      objects: 0,
      rows: 9,
      durationMs: 40,
      skipped: options.skipped ?? [],
    };
  });
  host.handle('dump.reveal', (request) => {
    calls.reveal.push(request);
    return { done: true };
  });
  host.on('dump.cancel', () => {
    calls.cancels += 1;
  });
  host.handle('sync.options', () => ({
    connections: [
      { id: 'c1', name: 'Local PG', detail: 'localhost:5432' },
      { id: 'c2', name: 'Staging', detail: 'stage:5432' },
    ],
  }));
  host.handle('sync.scopes', ({ connectionId, database }) => {
    calls.scopes.push({ connectionId, database });
    return connectionId === 'c2'
      ? { databases: ['stage'], schemas: ['public', 'extra'] }
      : { databases: ['shop', 'blog'], schemas: ['public'] };
  });
  host.handle('sync.start', (request) => {
    calls.syncStarts.push(request);
    if (options.startFails !== undefined) {
      throw new Error(options.startFails);
    }
    return { started: true };
  });
  host.on('compare.ready', () => {
    host.emit('compare.state', {
      source: 'Local PG · shop.public',
      target: 'Staging · stage.public',
      items: [{ id: 'table:orders', kind: 'table', name: 'orders', status: 'added' }],
    });
  });
  host.on('monitor.ready', () => {
    calls.monitor.push('ready');
    host.emit('monitor.state', {
      connectionName: 'Local PG',
      server: 'PostgreSQL',
      features: {
        processes: true,
        cancel: true,
        terminate: true,
        scopes: ['session'],
        serverScope: 'server',
      },
      readOnly: false,
    });
  });
  host.handle('monitor.processes', () => {
    calls.monitor.push('processes');
    return {
      rows: [
        {
          id: '77',
          user: 'app',
          state: 'active',
          seconds: 3,
          query: 'SELECT pg_sleep(9)',
          idle: false,
          mine: false,
        },
      ],
      at: 0,
    };
  });
  host.handle('monitor.status', () => {
    calls.monitor.push('status');
    return {
      rows: [{ name: 'Questions', value: '1200' }],
      summary: { version: '15.19', uptimeSeconds: 3725 },
      at: 0,
    };
  });
  host.on('ready', () => {
    host.emit('state', options.state ?? STATE);
  });
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  await screen.findByRole('heading', { level: 1 });
  return { host, calls };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = (name: string): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name });
const input = (label: string | RegExp): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>(label);
const selectIn = (testId: string, label: string): HTMLSelectElement =>
  within(screen.getByTestId(testId)).getByLabelText<HTMLSelectElement>(label);

function section(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('Manager page shell', () => {
  it('names the connection, lists the sections and opens the one asked for', async () => {
    await setup({ state: { ...STATE, section: 'dump' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Manager');
    expect(screen.getAllByText('Local PG').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent.trim())).toEqual([
      'Log',
      'Dashboard',
      'Processes',
      'Dump',
      'Structure Sync',
    ]);
    expect(section('Dump').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('manager-tab-dump');
  });

  it('shows only the sections of the connection', async () => {
    await setup({ state: { ...STATE, sections: ['log', 'dump'] } });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('marks a production and a read-only connection in words', async () => {
    await setup({ state: { ...STATE, production: true, readOnly: true } });
    expect(screen.getByText('production')).toBeTruthy();
    expect(screen.getByText('read-only')).toBeTruthy();
  });

  it('shows the database, schema and table it stands on in the status line', async () => {
    await setup({ state: { ...STATE, table: { name: 'orders', kind: 'table' } } });
    const status = screen.getByRole('contentinfo').textContent;
    for (const part of ['Local PG', 'shop', 'public', 'orders']) {
      expect(status).toContain(part);
    }
  });

  it('moves between the sections with the arrow keys, Home and End', async () => {
    await setup();
    await fireEvent.keyDown(section('Log'), { key: 'ArrowDown' });
    expect(section('Dashboard').getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(section('Dashboard'), { key: 'End' });
    expect(section('Structure Sync').getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(section('Structure Sync'), { key: 'ArrowDown' });
    expect(section('Log').getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(section('Log'), { key: 'ArrowUp' });
    expect(section('Structure Sync').getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(section('Structure Sync'), { key: 'Home' });
    expect(section('Log').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps one tab stop for the list of sections', async () => {
    await setup();
    expect(section('Log').getAttribute('tabindex')).toBe('0');
    expect(section('Dump').getAttribute('tabindex')).toBe('-1');
  });

  it('follows a new state from the host, e.g. when it is asked for again on Dump', async () => {
    const { host } = await setup();
    host.emit('state', { ...STATE, section: 'sync' });
    await waitFor(() => {
      expect(section('Structure Sync').getAttribute('aria-selected')).toBe('true');
    });
  });
});

describe('table bar', () => {
  it('is not shown on a page that was not opened from a table', async () => {
    await setup();
    expect(screen.queryByTestId('table-bar')).toBeNull();
  });

  it('lights Manager and takes the user to the other pages of the table', async () => {
    const { host } = await setup({
      state: { ...STATE, table: { name: 'orders', kind: 'table' } },
    });
    const seen: unknown[] = [];
    host.on('tableNav', (nav) => {
      seen.push(nav);
    });
    expect(screen.getByTestId('table-tab-manager').getAttribute('aria-current')).toBe('page');
    await fireEvent.click(screen.getByTestId('table-tab-data'));
    await fireEvent.click(screen.getByTestId('table-tab-er'));
    await fireEvent.click(screen.getByTestId('table-history'));
    await flush();
    expect(seen).toEqual([
      { action: 'data', dirty: false },
      { action: 'er', dirty: false },
      { action: 'history', dirty: false },
    ]);
  });

  it('leaves out what only a table can do on a view', async () => {
    await setup({ state: { ...STATE, table: { name: 'v_sales', kind: 'view' } } });
    expect(screen.queryByTestId('table-tab-er')).toBeNull();
    expect(screen.queryByTestId('table-tab-compare')).toBeNull();
    expect(screen.getByTestId('table-tab-data')).toBeTruthy();
  });
});

describe('Log section', () => {
  it('prints every statement with its result, an error in red', async () => {
    await setup();
    const lines = await screen.findAllByTestId('log-line');
    expect(lines).toHaveLength(3);
    expect(lines[0]?.textContent).toContain('2026-10-31 14:05:09');
    expect(lines[0]?.textContent).toContain('SELECT * FROM users');
    expect(lines[0]?.textContent).toContain('3 rows retrieved in 12 ms');
    expect(lines[1]?.textContent).toContain('2 rows affected in 4 ms');
    expect(lines[1]?.textContent).toContain('× 3');
    expect(lines[2]?.textContent).toContain('Failed in 1.5 s');
    expect(lines[2]?.textContent).toContain('permission denied');
    expect(lines[2]?.classList.contains('failed')).toBe(true);
  });

  it('filters by words and by errors only', async () => {
    await setup();
    await screen.findAllByTestId('log-line');
    await fireEvent.input(screen.getByLabelText('Filter statements'), {
      target: { value: 'orders' },
    });
    expect(screen.getAllByTestId('log-line')).toHaveLength(1);
    expect(screen.getByText('1 of 3')).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Filter statements'), { target: { value: 'zzz' } });
    expect(screen.getByText('No statement matches the filter')).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Filter statements'), { target: { value: '' } });
    await fireEvent.click(screen.getByLabelText('Errors only (1)'));
    expect(screen.getAllByTestId('log-line')).toHaveLength(1);
    expect(screen.getByTestId('log-line').textContent).toContain('DROP TABLE x');
  });

  it('says so when nothing has run yet', async () => {
    await setup({ log: [] });
    expect(await screen.findByText('No statements yet')).toBeTruthy();
    expect(button('Clear the log').disabled).toBe(true);
  });

  it('reads again when the host says the statements changed', async () => {
    const { host } = await setup({ log: [] });
    await screen.findByText('No statements yet');
    // The host's list is a closure over `log`; a changed event simply asks again.
    host.emit('log.changed', {});
    await flush();
    expect(screen.queryAllByTestId('log-line')).toHaveLength(0);
  });

  it('clears the log only when the host says the user agreed', async () => {
    const declined = await setup({ clear: false });
    await screen.findAllByTestId('log-line');
    await fireEvent.click(screen.getByRole('button', { name: 'Clear the log' }));
    await flush();
    expect(declined.calls.clear).toBe(1);
    expect(screen.getAllByTestId('log-line')).toHaveLength(3);
    cleanup();
    const agreed = await setup({ clear: true });
    await screen.findAllByTestId('log-line');
    await fireEvent.click(screen.getByRole('button', { name: 'Clear the log' }));
    expect(await screen.findByText('No statements yet')).toBeTruthy();
    expect(agreed.calls.clear).toBe(1);
  });

  it('copies the visible lines as text', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await setup();
    await screen.findAllByTestId('log-line');
    await fireEvent.input(screen.getByLabelText('Filter statements'), {
      target: { value: 'users' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy the log' }));
    expect(writeText).toHaveBeenCalledWith(
      '2026-10-31 14:05:09 SELECT * FROM users\n3 rows retrieved in 12 ms',
    );
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});

describe('Dump section', () => {
  async function openDump(options: Parameters<typeof setup>[0] = {}): Promise<Setup> {
    const made = await setup({ ...options, state: { ...STATE, section: 'dump' } });
    await screen.findByTestId('dump-relations');
    return made;
  }

  it('lists the tables and views, all ticked, with the output path', async () => {
    await openDump();
    const boxes = within(screen.getByTestId('dump-relations')).getAllByRole<HTMLInputElement>(
      'checkbox',
    );
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.checked)).toBe(true);
    expect(input('Output file').value).toBe('/work/shop-2026-10-31-1405.sql');
    expect(screen.getByText('Tables and views (3 of 3)')).toBeTruthy();
    expect(screen.getByText(/no pg_dump or mysqldump is needed/u)).toBeTruthy();
  });

  it('asks for the tables of another database when it changes', async () => {
    const { calls } = await openDump();
    await fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'blog' } });
    await waitFor(() => {
      expect(screen.getByText('Tables and views (1 of 1)')).toBeTruthy();
    });
    expect(calls.optionRequests.at(-1)).toEqual({ database: 'blog' });
    // The path the user may have edited is kept.
    expect(input('Output file').value).toBe('/work/shop-2026-10-31-1405.sql');
  });

  it('asks again with the database and the schema when the schema changes', async () => {
    const { calls } = await openDump();
    await fireEvent.change(screen.getByLabelText('Schema'), { target: { value: 'public' } });
    await waitFor(() => {
      expect(calls.optionRequests.at(-1)).toEqual({ database: 'shop', schema: 'public' });
    });
  });

  it('ticks, unticks and filters the tables', async () => {
    await openDump();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Tables and views (0 of 3)')).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Filter tables'), { target: { value: 'user' } });
    expect(within(screen.getByTestId('dump-relations')).getAllByRole('checkbox')).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('Tables and views (1 of 3)')).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Filter tables'), { target: { value: 'zzz' } });
    expect(screen.getByText('There is nothing here to dump')).toBeTruthy();
  });

  it('runs with what the form says', async () => {
    const { calls } = await openDump();
    await fireEvent.click(screen.getByLabelText('Data only'));
    await fireEvent.click(within(screen.getByTestId('dump-relations')).getByLabelText('v_sales'));
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByTestId('dump-done')).toBeTruthy();
    expect(calls.runs).toEqual([
      {
        database: 'shop',
        schema: 'public',
        relations: ['orders', 'users'],
        wholeScope: true,
        content: 'data',
        dropFirst: true,
        output: '/work/shop-2026-10-31-1405.sql',
      },
    ]);
    expect(screen.getByTestId('dump-done').textContent).toContain(
      'Dump saved: 2 tables, 1 views, 9 rows, 2.0 KB in 40 ms',
    );
  });

  it('disables the drop option for a data-only dump', async () => {
    await openDump();
    expect(input(/Add DROP/u).disabled).toBe(false);
    await fireEvent.click(screen.getByLabelText('Data only'));
    expect(input(/Add DROP/u).disabled).toBe(true);
  });

  it('cannot run with nothing ticked, no routines and no path', async () => {
    await openDump();
    const run = button('Run');
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(run.disabled).toBe(false);
    await fireEvent.click(screen.getByLabelText('Also routines, events, sequences and types'));
    expect(run.disabled).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(run.disabled).toBe(false);
    await fireEvent.input(screen.getByLabelText('Output file'), { target: { value: '  ' } });
    expect(run.disabled).toBe(true);
  });

  it('takes the file the save dialog picks', async () => {
    await openDump();
    await fireEvent.click(screen.getByRole('button', { name: 'Choose a file' }));
    await waitFor(() => {
      expect(input('Output file').value).toBe('/elsewhere/dump.sql');
    });
  });

  it('shows the progress and the way to stop while it runs', async () => {
    const { calls } = await openDump({ hold: true });
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('orders: 10 rows · table 2 of 4')).toBeTruthy();
    expect(button('Run').disabled).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(calls.cancels).toBe(1);
  });

  it('shows the error of a failed dump', async () => {
    await openDump({ runFails: 'disk full' });
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
    expect(screen.queryByTestId('dump-done')).toBeNull();
    expect(button('Run').disabled).toBe(false);
  });

  it('names what the server kept from the dump, and opens the file or its folder', async () => {
    const { calls } = await openDump({ skipped: ['secret_fn'] });
    await fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const done = await screen.findByTestId('dump-done');
    expect(done.textContent).toContain('secret_fn');
    await fireEvent.click(within(done).getByRole('button', { name: 'Open' }));
    await fireEvent.click(within(done).getByRole('button', { name: 'Show in folder' }));
    await flush();
    expect(calls.reveal).toEqual([
      { path: '/work/shop-2026-10-31-1405.sql', how: 'open' },
      { path: '/work/shop-2026-10-31-1405.sql', how: 'folder' },
    ]);
  });
});

describe('Structure Sync section', () => {
  async function openSync(options: Parameters<typeof setup>[0] = {}): Promise<Setup> {
    const made = await setup({ ...options, state: { ...STATE, section: 'sync' } });
    await screen.findByTestId('sync-source');
    return made;
  }

  async function chooseTarget(): Promise<void> {
    await fireEvent.change(within(screen.getByTestId('sync-target')).getByLabelText('Connection'), {
      target: { value: 'c2' },
    });
    await waitFor(() => {
      expect(within(screen.getByTestId('sync-target')).getAllByRole('combobox')).toHaveLength(3);
    });
  }

  it('starts the reference on the schema the page stands on', async () => {
    await openSync();
    await waitFor(() => {
      expect(selectIn('sync-source', 'Connection').value).toBe('c1');
    });
    await waitFor(() => {
      expect(selectIn('sync-source', 'Database').value).toBe('shop');
    });
    expect(selectIn('sync-source', 'Schema').value).toBe('public');
  });

  it('cannot compare before a target is chosen, nor a schema with itself', async () => {
    await openSync();
    const compare = button('Compare');
    expect(compare.disabled).toBe(true);
    const target = within(screen.getByTestId('sync-target'));
    await fireEvent.change(target.getByLabelText('Connection'), { target: { value: 'c1' } });
    await waitFor(() => {
      expect(target.getAllByRole('combobox')).toHaveLength(3);
    });
    // Same connection, database and schema as the reference.
    await fireEvent.change(target.getByLabelText('Database'), { target: { value: 'shop' } });
    await waitFor(() => {
      expect(compare.disabled).toBe(true);
    });
    await fireEvent.change(target.getByLabelText('Database'), { target: { value: 'blog' } });
    await waitFor(() => {
      expect(compare.disabled).toBe(false);
    });
  });

  it('starts the comparison and shows the schema comparison page in the section', async () => {
    const { calls } = await openSync();
    await waitFor(() => {
      expect(calls.scopes.length).toBeGreaterThan(0);
    });
    await chooseTarget();
    await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => {
      expect(calls.syncStarts).toHaveLength(1);
    });
    expect(calls.syncStarts[0]).toEqual({
      source: { connectionId: 'c1', database: 'shop', schema: 'public' },
      target: { connectionId: 'c2', database: 'stage', schema: 'public' },
    });
    // The hosted page's own state arrives under the prefix.
    expect(await screen.findByText('Staging · stage.public')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New comparison' })).toBeTruthy();
  });

  it('goes back to the form for a new comparison', async () => {
    await openSync();
    await chooseTarget();
    await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'New comparison' }));
    expect(await screen.findByTestId('sync-source')).toBeTruthy();
  });

  it('shows why the comparison could not start', async () => {
    await openSync({ startFails: 'Pick another database or schema to compare with' });
    await chooseTarget();
    await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Pick another database');
    expect(screen.getByTestId('sync-source')).toBeTruthy();
  });
});

describe('Dashboard and Processes sections', () => {
  it('shows the status of the server without the monitor page tabs', async () => {
    const { calls } = await setup({ state: { ...STATE, section: 'dashboard' } });
    await waitFor(() => {
      expect(calls.monitor).toContain('status');
    });
    expect(await screen.findByTestId('cards')).toBeTruthy();
    expect(screen.getByTestId('server').textContent).toBe('PostgreSQL 15.19');
    expect(calls.monitor).not.toContain('processes');
    // The hosted page's own title and tab strip are the Manager's job here.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.tabs')?.hidden).toBe(true);
  });

  it('shows the processes of the server', async () => {
    const { calls } = await setup({ state: { ...STATE, section: 'processes' } });
    await waitFor(() => {
      expect(calls.monitor).toContain('processes');
    });
    expect(await screen.findByText('SELECT pg_sleep(9)')).toBeTruthy();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  queryPlanProtocol,
  type QueryPlanProtocol,
  type QueryPlanRow,
  type QueryPlanState,
} from '../../../../../src/shared/protocols/query-plan';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/query-plan/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<QueryPlanProtocol['host'], QueryPlanProtocol['webview']>;

const row = (
  operation: string,
  depth: number,
  descendants: number,
  extra: Partial<QueryPlanRow> = {},
): QueryPlanRow => ({
  depth,
  operation,
  warnings: [],
  properties: [],
  self: 0,
  share: 0,
  heat: 'none',
  descendants,
  ...extra,
});

function state(overrides: Partial<QueryPlanState> = {}): QueryPlanState {
  return {
    statement: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
    connection: 'Local',
    canAnalyze: true,
    running: false,
    analyzed: false,
    basis: 'cost',
    rows: [
      row('Hash Join', 0, 3, {
        cost: 76.9,
        rows: 1429,
        share: 0.2,
        self: 15,
        heat: 'warm',
        detail: 'Hash Cond: (o.customer_id = c.id)',
      }),
      row('Seq Scan', 1, 0, {
        object: 'orders o',
        cost: 24.5,
        rows: 1450,
        share: 0.6,
        self: 24.5,
        heat: 'hot',
        warnings: ['full-scan'],
        properties: [['Alias', 'o']],
      }),
      row('Hash', 1, 1, { cost: 10.9, rows: 69 }),
      row('Seq Scan', 2, 0, {
        object: 'customers c',
        cost: 10.9,
        rows: 69,
        share: 0.2,
        heat: 'mild',
      }),
    ],
    properties: [['Planning Time', '0.1 ms']],
    notes: ['CREATE INDEX ON orders (customer_id)'],
    ...overrides,
  };
}

async function setup(initial: QueryPlanState | null = state()) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: queryPlanProtocol.host,
    remote: queryPlanProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: queryPlanProtocol.webview,
    remote: queryPlanProtocol.host,
    transport: transports.webview,
  });
  const events = { ready: vi.fn(), explain: vi.fn(), showRaw: vi.fn() };
  host.on('ready', events.ready);
  host.on('explain', events.explain);
  host.on('showRaw', events.showRaw);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  if (initial !== null) {
    host.emit('state', initial);
    await waitFor(() => {
      expect(screen.queryByText(initial.statement)).not.toBeNull();
    });
  }
  return { host, events };
}

const items = (): HTMLElement[] => screen.queryAllByRole('treeitem');

beforeAll(() => {
  document.documentElement.lang = 'en';
  // jsdom lays nothing out, so it has no scrolling either.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('query plan page', () => {
  it('asks for the state and waits for it', async () => {
    const page = await setup(null);
    expect(page.events.ready).toHaveBeenCalled();
    expect(screen.getByText('Loading…')).not.toBeNull();
  });

  it('draws the plan as a tree with shares, warnings and advice', async () => {
    await setup();
    expect(screen.getByText('Estimated')).not.toBeNull();
    expect(items()).toHaveLength(4);
    const scan = items()[1];
    expect(scan?.getAttribute('aria-level')).toBe('2');
    expect(scan?.classList.contains('heat-hot')).toBe(true);
    expect(scan?.textContent).toContain('orders o');
    expect(scan?.textContent).toContain('full scan');
    expect(scan?.textContent).toContain('60%');
    expect(items()[0]?.textContent).toContain('Hash Cond: (o.customer_id = c.id)');
    expect(screen.getByText('CREATE INDEX ON orders (customer_id)')).not.toBeNull();
    expect(screen.getByText('Shares of the estimated cost.', { exact: false })).not.toBeNull();
  });

  it('shows the details of the row clicked, with the hint of each warning', async () => {
    await setup();
    const scan = items()[1];
    if (scan === undefined) {
      throw new Error('no row');
    }
    await fireEvent.click(scan);
    const details = screen.getByRole('complementary');
    expect(details.textContent).toContain('Alias');
    expect(details.textContent).toContain('Reads the whole table or index');
    expect(details.textContent).toMatch(/60%\s*\(24\.5\s*\)/u);
  });

  it('collapses and expands a branch, and all of them', async () => {
    await setup();
    const [, hash] = screen.getAllByRole('button', { name: 'Collapse' });
    if (hash === undefined) {
      throw new Error('no Collapse button on Hash');
    }
    await fireEvent.click(hash);
    expect(items()).toHaveLength(3);
    await fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(items()).toHaveLength(4);
    await fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(items()).toHaveLength(3);
    await fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(items()).toHaveLength(4);
  });

  it('moves through the tree with the keyboard', async () => {
    await setup();
    const tree = screen.getByRole('tree');
    await fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(items()[1]?.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(tree, { key: 'End' });
    expect(items()[3]?.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(items()[2]?.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(items()).toHaveLength(3);
    await fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(items()).toHaveLength(4);
    await fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(items()[3]?.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(tree, { key: 'Home' });
    expect(items()[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('asks for another explain, with or without running the statement', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Explain Analyze' }));
    await waitFor(() => {
      expect(page.events.explain).toHaveBeenCalledTimes(2);
    });
    expect(page.events.explain.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { analyze: false },
      { analyze: true },
    ]);
    await fireEvent.click(screen.getByRole('button', { name: 'Show original' }));
    await waitFor(() => {
      expect(page.events.showRaw).toHaveBeenCalled();
    });
  });

  it('cannot analyze where the host says so, nor while a run is going on', async () => {
    const page = await setup(state({ canAnalyze: false }));
    expect(screen.getByRole('button', { name: 'Explain Analyze' }).hasAttribute('disabled')).toBe(
      true,
    );
    page.host.emit('state', state({ running: true }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Explaining…');
    });
    expect(screen.getByRole('button', { name: 'Explain' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the work going on as a bar on top while it explains', async () => {
    const page = await setup();
    expect(screen.queryByRole('progressbar')).toBeNull();
    page.host.emit('state', state({ running: true }));
    await waitFor(() => {
      expect(screen.getByRole('progressbar', { name: 'Explaining…' })).toBeTruthy();
    });
    // The plan read before stays on screen until the new one comes.
    expect(items()).toHaveLength(4);
  });

  it('says so when the server returns no plan and no error', async () => {
    await setup(state({ rows: [], notes: [], properties: [] }));
    expect(screen.getByText('The server returned no plan for this statement')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand all' }).hasAttribute('disabled')).toBe(true);
  });

  it('names its icon buttons and says which plan it shows', async () => {
    await setup();
    for (const name of ['Expand all', 'Collapse all', 'Show original']) {
      expect(screen.getByRole('button', { name }).getAttribute('title')).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Explain Analyze' }).getAttribute('title')).toBe(
      'Runs the statement and shows real rows and times',
    );
  });

  it('shows real times and loops once the statement ran', async () => {
    await setup(
      state({
        analyzed: true,
        basis: 'time',
        rows: [
          row('Sort', 0, 0, {
            timeMs: 3.39,
            actualRows: 4,
            rows: 69,
            loops: 1,
            share: 1,
            heat: 'hot',
          }),
        ],
      }),
    );
    expect(screen.getByText('Actual')).not.toBeNull();
    expect(items()[0]?.textContent).toContain('3.39 ms');
    expect(items()[0]?.textContent).toContain('69 → 4');
    expect(screen.getByText('Loops')).not.toBeNull();
  });

  it('shows the error of a failed explain', async () => {
    await setup(state({ rows: [], error: 'syntax error at or near "SELEC"' }));
    expect(screen.getByRole('alert').textContent).toBe('syntax error at or near "SELEC"');
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('keeps the folded branches when the same plan comes again, and starts over for another', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    page.host.emit('state', state());
    await flush();
    expect(items()).toHaveLength(3);
    page.host.emit('state', state({ rows: [row('Result', 0, 0)] }));
    await waitFor(() => {
      expect(items()).toHaveLength(1);
    });
    expect(items()[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('says that a database without costs is read by its warnings', async () => {
    await setup(
      state({ basis: 'none', rows: [row('Scan', 0, 0, { object: 't', warnings: ['full-scan'] })] }),
    );
    expect(
      screen.getByText('This database gives no costs; look at the warnings.', { exact: false }),
    ).not.toBeNull();
    expect(items()[0]?.textContent).not.toContain('%');
  });
});

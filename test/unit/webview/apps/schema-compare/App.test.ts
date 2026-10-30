import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  schemaCompareProtocol,
  type SchemaCompareDetail,
  type SchemaCompareProtocol,
  type SchemaCompareState,
} from '../../../../../src/shared/protocols/schema-compare';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/schema-compare/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<SchemaCompareProtocol['host'], SchemaCompareProtocol['webview']>;

function state(overrides: Partial<SchemaCompareState> = {}): SchemaCompareState {
  return {
    source: 'Local · src',
    target: 'Prod · dst',
    items: [
      { id: 'table:customers', kind: 'table', name: 'customers', status: 'changed' },
      { id: 'table:notes', kind: 'table', name: 'notes', status: 'added' },
      { id: 'table:legacy', kind: 'table', name: 'legacy', status: 'removed' },
      { id: 'table:same', kind: 'table', name: 'same_one', status: 'same' },
      { id: 'view:v', kind: 'view', name: 'big_orders', status: 'changed' },
      { id: 'proc:p', kind: 'procedure', name: 'secret', status: 'changed', hidden: true },
    ],
    ...overrides,
  };
}

const tableDetail: SchemaCompareDetail = {
  id: 'table:customers',
  columns: [
    { name: 'email', change: 'added', after: 'varchar(100)' },
    { name: 'name', change: 'changed', before: 'varchar(20)', after: 'varchar(50) NOT NULL' },
  ],
  keys: [{ kind: 'foreignKey', name: 'fk_c', change: 'removed', before: '(c) → t (id)' }],
  comment: { before: 'old', after: 'new' },
  notes: ['generated column g is only in the source'],
  diff: [],
  script: 'ALTER TABLE "dst"."customers" ADD COLUMN "email" varchar(100);\n',
};

async function setup(initial: SchemaCompareState | null = state()) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: schemaCompareProtocol.host,
    remote: schemaCompareProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: schemaCompareProtocol.webview,
    remote: schemaCompareProtocol.host,
    transport: transports.webview,
  });
  const scripts: string[][] = [];
  const events = { ready: vi.fn(), refresh: vi.fn(), swap: vi.fn() };
  host.on('ready', events.ready);
  host.on('refresh', events.refresh);
  host.on('swap', events.swap);
  host.handle('detail', ({ id }) => {
    if (id === 'view:v') {
      return {
        id,
        columns: [],
        keys: [],
        notes: [],
        diff: [
          { op: 'same', text: 'CREATE VIEW v AS' },
          { op: 'remove', text: 'WHERE total > 50' },
          { op: 'add', text: 'WHERE total > 100' },
        ],
        script: '',
      };
    }
    if (id === 'table:customers') {
      return tableDetail;
    }
    throw new Error('This difference is no longer in the comparison');
  });
  host.handle('openScript', ({ ids }) => {
    scripts.push(ids);
    return { opened: true };
  });
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  if (initial !== null) {
    host.emit('state', initial);
    await waitFor(() => {
      expect(screen.getByText('Local · src')).not.toBeNull();
    });
  }
  return { host, events, scripts };
}

const box = (name: string): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>(`Put ${name} into the script`);

describe('schema comparison page', () => {
  it('asks for the state and shows the reading progress', async () => {
    const page = await setup(null);
    expect(page.events.ready).toHaveBeenCalled();
    page.host.emit('state', state({ items: [], loading: { side: 'target', done: 2, total: 9 } }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent.trim()).toBe('Reading the target: 2 of 9');
    });
  });

  it('lists differences by kind with counts, and ticks new and changed ones', async () => {
    await setup();
    expect(screen.getByText('New: 1')).not.toBeNull();
    expect(screen.getByText('Different: 3')).not.toBeNull();
    expect(screen.getByText('Only in the target: 1')).not.toBeNull();
    expect(screen.getByText('Same: 1')).not.toBeNull();
    expect(box('customers').checked).toBe(true);
    expect(box('notes').checked).toBe(true);
    expect(box('legacy').checked).toBe(false);
    expect(box('secret').disabled).toBe(true);
    expect(screen.queryByText('same_one')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open script (3)' })).not.toBeNull();
  });

  it('shows identical objects on request', async () => {
    await setup();
    await fireEvent.click(screen.getByLabelText('Show the same ones'));
    expect(screen.getByText('same_one')).not.toBeNull();
    expect(box('same_one').disabled).toBe(true);
  });

  it('shows the column, key and comment changes of a table and its script', async () => {
    await setup();
    await fireEvent.click(screen.getByText('customers'));
    await waitFor(() => {
      expect(screen.getByText('email')).not.toBeNull();
    });
    const detail = screen.getByRole('region', { name: 'Difference' });
    expect(detail.textContent).toContain('varchar(20)');
    expect(detail.textContent).toContain('varchar(50) NOT NULL');
    expect(detail.textContent).toContain('fk_c');
    expect(detail.textContent).toContain('generated column g is only in the source');
    expect(detail.textContent).toContain('ALTER TABLE "dst"."customers"');
  });

  it('shows a definition as lines removed and added', async () => {
    await setup();
    await fireEvent.click(screen.getByText('big_orders'));
    await waitFor(() => {
      expect(screen.getByText('- WHERE total > 50', { exact: false })).not.toBeNull();
    });
    expect(screen.getByText('Nothing to write for it.')).not.toBeNull();
  });

  it('shows why a difference cannot be shown', async () => {
    await setup();
    await fireEvent.click(screen.getByText('notes'));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('no longer in the comparison');
    });
  });

  it('opens the script of the ticked differences', async () => {
    const page = await setup();
    await fireEvent.click(box('legacy'));
    await fireEvent.click(box('notes'));
    await fireEvent.click(screen.getByRole('button', { name: 'Open script (3)' }));
    await waitFor(() => {
      expect(page.scripts).toHaveLength(1);
    });
    expect([...(page.scripts[0] ?? [])].sort()).toEqual([
      'table:customers',
      'table:legacy',
      'view:v',
    ]);
  });

  it('ticks all and none', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Tick all' }));
    expect(box('legacy').checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Open script (4)' })).not.toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Tick none' }));
    expect(screen.getByRole('button', { name: 'Open script (0)' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('swaps and refreshes through the host', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(page.events.swap).toHaveBeenCalled();
      expect(page.events.refresh).toHaveBeenCalled();
    });
  });

  it('says so when the schemas are the same, and shows a read error', async () => {
    const page = await setup(
      state({ items: [{ id: 't', kind: 'table', name: 't', status: 'same' }] }),
    );
    expect(screen.getByText('The schemas are the same.')).not.toBeNull();
    page.host.emit('state', state({ items: [], error: 'permission denied for schema dst' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('permission denied for schema dst');
    });
  });
});

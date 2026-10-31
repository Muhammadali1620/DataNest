import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  redisKeyProtocol,
  type RedisKeyProtocol,
  type RedisKeyState,
} from '../../../../../src/shared/protocols/redis-key';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/redis-key/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<RedisKeyProtocol['host'], RedisKeyProtocol['webview']>;

function state(overrides: Partial<RedisKeyState> = {}): RedisKeyState {
  return {
    key: { text: 'user:1' },
    database: 0,
    connectionName: 'Cache',
    readOnly: false,
    exists: true,
    type: 'string',
    ttlMs: null,
    length: 5,
    value: { text: 'hello' },
    ...overrides,
  };
}

const HASH: Partial<RedisKeyState> = {
  type: 'hash',
  length: 2,
  value: undefined,
  items: [
    { field: { text: 'name' }, value: { text: 'Alice' } },
    { field: { text: 'mail' }, value: { text: 'a@x' } },
  ],
  more: true,
};

async function open(initial: RedisKeyState) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: redisKeyProtocol.host,
    remote: redisKeyProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: redisKeyProtocol.webview,
    remote: redisKeyProtocol.host,
    transport: transports.webview,
  });
  const ready = vi.fn();
  host.on('ready', ready);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  expect(ready).toHaveBeenCalled();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return host;
}

describe('Redis key page', () => {
  it('shows the key, its type, size and database', async () => {
    await open(state({ memory: 2048, encoding: 'embstr' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('user:1');
    const meta = screen.getByTestId('meta').textContent;
    expect(meta).toContain('string');
    expect(meta).toContain('db0 · Cache');
    expect(meta).toContain('5 bytes');
    expect(meta).toContain('2.0 KB in memory');
    expect(meta).toContain('embstr');
    expect(screen.getByTestId('ttl').textContent).toContain('No expiry');
  });

  it('counts the TTL down', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open(state({ ttlMs: 65_000 }));
      expect(screen.getByTestId('ttl').textContent).toContain('00:01:05');
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByTestId('ttl').textContent).toContain('00:01:03');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves an edited string', async () => {
    const host = await open(state());
    const setString = vi.fn(() => ({}));
    host.handle('setString', setString);
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'changed' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(setString).toHaveBeenCalledWith({ value: { text: 'changed' } });
    });
  });

  it('cannot save a cut string, and says why', async () => {
    await open(state({ value: { text: 'abc', truncated: true, size: 5_000_000 } }));
    expect(screen.getByTestId('truncated').textContent).toContain('5000000');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('shows the error the host sends back', async () => {
    const host = await open(state());
    host.handle('setTtl', () => {
      throw new Error('NOPERM no permission');
    });
    await fireEvent.input(screen.getByLabelText('Set TTL'), { target: { value: '30' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Set TTL' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('NOPERM');
    });
  });

  it('sets the TTL and renames on Enter, and removes the TTL', async () => {
    const host = await open(state({ ttlMs: 65_000 }));
    const setTtl = vi.fn(() => ({}));
    const rename = vi.fn(() => ({ renamed: true }));
    host.handle('setTtl', setTtl);
    host.handle('rename', rename);
    const ttl = screen.getByLabelText<HTMLInputElement>('Set TTL');
    // Not a number of seconds: Enter does nothing.
    await fireEvent.input(ttl, { target: { value: 'soon' } });
    await fireEvent.keyDown(ttl, { key: 'Enter' });
    expect(setTtl).not.toHaveBeenCalled();
    await fireEvent.input(ttl, { target: { value: '90' } });
    await fireEvent.keyDown(ttl, { key: 'Enter' });
    await waitFor(() => {
      expect(setTtl).toHaveBeenCalledWith({ seconds: 90 });
    });
    await waitFor(() => {
      expect(ttl.value).toBe('');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove TTL' }));
    await waitFor(() => {
      expect(setTtl).toHaveBeenLastCalledWith({ seconds: null });
    });
    const name = screen.getByLabelText('New name');
    // The same name is no rename.
    await fireEvent.keyDown(name, { key: 'Enter' });
    expect(rename).not.toHaveBeenCalled();
    await fireEvent.input(name, { target: { value: 'user:9' } });
    await fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => {
      expect(rename).toHaveBeenCalledWith({ name: 'user:9' });
    });
  });

  it('shows the type and the TTL as badges, the expiry marked', async () => {
    await open(state({ ttlMs: 65_000 }));
    const ttl = screen.getByTestId('ttl');
    expect(ttl.classList.contains('badge')).toBe(true);
    expect(ttl.classList.contains('expiring')).toBe(true);
  });

  it('closes the item editor with its Close button', async () => {
    await open(state(HASH));
    await fireEvent.click(screen.getByText('Alice'));
    expect(await screen.findByRole('region', { name: 'Item' })).toBeTruthy();
    const row = screen.getByText('Alice').closest('tr');
    expect(row?.getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Item' })).toBeNull();
    expect(row?.getAttribute('aria-selected')).toBe('false');
  });

  it('opens an item from the keyboard', async () => {
    await open(state(HASH));
    const row = screen.getByText('a@x').closest('tr');
    if (row === null) {
      throw new Error('no row');
    }
    await fireEvent.keyDown(row, { key: 'Enter' });
    expect(await screen.findByRole('region', { name: 'Item' })).toBeTruthy();
  });

  it('lists hash fields and edits the one clicked', async () => {
    const host = await open(state(HASH));
    const setField = vi.fn(() => ({}));
    host.handle('setField', setField);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    await fireEvent.click(screen.getByText('Alice'));
    const value = await screen.findByLabelText('Value');
    await fireEvent.input(value, { target: { value: 'Alicia' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(setField).toHaveBeenCalledWith({ field: { text: 'name' }, value: { text: 'Alicia' } });
    });
  });

  it('deletes the clicked item', async () => {
    const host = await open(state(HASH));
    const deleteField = vi.fn(() => ({}));
    host.handle('deleteField', deleteField);
    await fireEvent.click(screen.getByText('a@x'));
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteField).toHaveBeenCalledWith({ field: { text: 'mail' } });
    });
  });

  it('loads more items and filters them', async () => {
    const host = await open(state(HASH));
    const loadMore = vi.fn(() => ({}));
    const filter = vi.fn(() => ({}));
    host.handle('loadMore', loadMore);
    host.handle('filter', filter);
    await fireEvent.click(screen.getByRole('button', { name: 'Load more (2 shown)' }));
    await fireEvent.input(screen.getByLabelText('Filter'), { target: { value: 'na*' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => {
      expect(filter).toHaveBeenCalledWith({ pattern: 'na*' });
    });
    expect(loadMore).toHaveBeenCalled();
  });

  it('adds a new list element at the chosen end', async () => {
    const host = await open(
      state({ type: 'list', value: undefined, items: [{ index: 0, value: { text: 'a' } }] }),
    );
    const push = vi.fn(() => ({}));
    host.handle('pushListItem', push);
    await fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    await fireEvent.input(await screen.findByLabelText('Value'), { target: { value: 'z' } });
    await fireEvent.change(screen.getByLabelText('Add to'), { target: { value: 'head' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith({ end: 'head', value: { text: 'z' } });
    });
  });

  it('renames and deletes the key through the host', async () => {
    const host = await open(state());
    const rename = vi.fn(() => ({ renamed: true }));
    const deleteKey = vi.fn(() => ({ deleted: false }));
    host.handle('rename', rename);
    host.handle('deleteKey', deleteKey);
    await fireEvent.input(screen.getByLabelText('New name'), { target: { value: 'user:2' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(rename).toHaveBeenCalledWith({ name: 'user:2' });
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => {
      expect(deleteKey).toHaveBeenCalled();
    });
  });

  it('offers no changes on a read-only connection', async () => {
    await open(state({ ...HASH, readOnly: true }));
    expect(screen.getByTestId('meta').textContent).toContain('read-only');
    for (const name of ['Delete key', 'Rename', 'Set TTL', 'Add…']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
  });

  it('says when the key is gone, and when its type is not shown', async () => {
    const host = await open(state({ exists: false, type: 'none', value: undefined }));
    expect(screen.getByTestId('gone')).toBeTruthy();
    host.emit('state', state({ type: 'ReJSON-RL', value: undefined }));
    await waitFor(() => {
      expect(screen.getByTestId('unsupported').textContent).toContain('ReJSON-RL');
    });
  });
});

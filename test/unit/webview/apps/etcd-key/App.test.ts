import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  etcdKeyProtocol,
  type EtcdKeyProtocol,
  type EtcdKeyState,
} from '../../../../../src/shared/protocols/etcd-key';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/etcd-key/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<EtcdKeyProtocol['host'], EtcdKeyProtocol['webview']>;

function state(overrides: Partial<EtcdKeyState> = {}): EtcdKeyState {
  return {
    key: { text: '/app/config' },
    connectionName: 'Cluster',
    readOnly: false,
    exists: true,
    value: { text: 'hello' },
    size: 5,
    modRevision: '12',
    createRevision: '9',
    version: 3,
    lease: null,
    ...overrides,
  };
}

interface Opened {
  host: HostPeer;
  requests: { method: string; params: unknown }[];
}

async function open(
  initial: EtcdKeyState,
  language: 'en' | 'ru' = 'en',
  answers: Record<string, unknown> = {},
): Promise<Opened> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: etcdKeyProtocol.host,
    remote: etcdKeyProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: etcdKeyProtocol.webview,
    remote: etcdKeyProtocol.host,
    transport: transports.webview,
  });
  const requests: Opened['requests'] = [];
  const reply = (method: string, fallback: unknown) => (params: unknown) => {
    requests.push({ method, params });
    const answer = answers[method];
    if (answer instanceof Error) {
      throw answer;
    }
    return (answer ?? fallback) as never;
  };
  host.handle('refresh', reply('refresh', {}));
  host.handle('save', reply('save', { saved: true }));
  host.handle('attachLease', reply('attachLease', {}));
  host.handle('detachLease', reply('detachLease', {}));
  host.handle('revokeLease', reply('revokeLease', { revoked: true }));
  host.handle('deleteKey', reply('deleteKey', { deleted: true }));
  host.handle('copyText', reply('copyText', {}));
  render(App, { props: { rpc, t: createTranslator(language) } });
  await flush();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return { host, requests };
}

const sent = (opened: Opened, method: string): unknown[] =>
  opened.requests.filter((request) => request.method === method).map((request) => request.params);

afterEach(() => {
  vi.useRealTimers();
});

describe('etcd key page: the key', () => {
  it('waits for the host, then shows the key with its revisions and size', () => {
    const transports = createLinkedTransports();
    const rpc = new RpcPeer({
      local: etcdKeyProtocol.webview,
      remote: etcdKeyProtocol.host,
      transport: transports.webview,
    });
    render(App, { props: { rpc, t: createTranslator('en') } });
    expect(screen.getByText('Loading the key…')).toBeTruthy();
    expect(transports.webview.posted.length).toBeGreaterThan(0);
  });

  it('shows the whole name, the revision, the version and the connection', async () => {
    await open(state());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('/app/config');
    const meta = screen.getByTestId('meta').textContent;
    expect(meta).toContain('Revision 12');
    expect(meta).toContain('Version 3');
    expect(meta).toContain('5 bytes');
    expect(meta).toContain('Cluster');
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('shows the value in the editor', async () => {
    await open(state({ value: { text: 'a value' } }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('a value');
  });

  it('is in Russian when asked', async () => {
    await open(state(), 'ru');
    expect(screen.getByTestId('meta').textContent).toContain('Ревизия 12');
    expect(screen.getByText('Привязать новую аренду')).toBeTruthy();
  });

  it('says a read-only connection is read-only and offers no change', async () => {
    await open(state({ readOnly: true }));
    expect(screen.getByTestId('meta').textContent).toContain('read-only');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete key' })).toBeNull();
    expect(screen.queryByPlaceholderText('seconds')).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value').readOnly).toBe(true);
  });

  it('does not offer to save a value that was cut', async () => {
    await open(state({ value: { text: 'a', truncated: true, size: 2_000_000 } }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByTestId('truncated')).toBeTruthy();
  });

  it('refreshes, copies the name and deletes on request', async () => {
    const opened = await open(state());
    // A request in flight keeps the next click from starting another, so each is awaited.
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(sent(opened, 'refresh')).toHaveLength(1);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy the key name' }));
    await waitFor(() => {
      expect(sent(opened, 'copyText')).toEqual([{ text: '/app/config' }]);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => {
      expect(sent(opened, 'deleteKey')).toHaveLength(1);
    });
  });

  it('shows what the host refused', async () => {
    await open(state(), 'en', { deleteKey: new Error('etcdserver: permission denied') });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('permission denied');
    });
  });
});

describe('etcd key page: saving', () => {
  it('keeps Save off until the text changes, then sends it with the revision it read', async () => {
    const opened = await open(state());
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'changed' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => {
      expect(sent(opened, 'save')).toEqual([{ value: { text: 'changed' }, modRevision: '12' }]);
    });
  });

  it('sends bytes written as hex', async () => {
    const opened = await open(state({ value: { text: '\\xff', hex: 'ff' } }));
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'ff 00' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent(opened, 'save')).toHaveLength(1);
    });
    expect(sent(opened, 'save')[0]).toMatchObject({ value: { hex: 'ff00' } });
  });

  it('takes the server value when a fresh state arrives without a conflict', async () => {
    const opened = await open(state());
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'my draft' } });
    opened.host.emit('state', state({ value: { text: 'server value' }, modRevision: '13' }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('server value');
    });
  });
});

describe('etcd key page: a conflict', () => {
  async function conflict(): Promise<Opened> {
    const opened = await open(state());
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'my draft' } });
    opened.host.emit(
      'state',
      state({ value: { text: 'theirs' }, modRevision: '15', conflict: true }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('conflict')).toBeTruthy();
    });
    return opened;
  }

  it('says the key changed, with the new revision, and keeps the text the user typed', async () => {
    await conflict();
    expect(screen.getByTestId('conflict').textContent).toContain('revision 15');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('my draft');
  });

  it('overwrites on purpose with the text the user typed, over the new revision', async () => {
    const opened = await conflict();
    await fireEvent.click(screen.getByRole('button', { name: 'Overwrite with my text' }));
    await waitFor(() => {
      expect(sent(opened, 'save')).toEqual([
        { value: { text: 'my draft' }, modRevision: '15', overwrite: true },
      ]);
    });
  });

  it('loads the server value on request', async () => {
    const opened = await conflict();
    await fireEvent.click(screen.getByRole('button', { name: 'Load the server value' }));
    await waitFor(() => {
      expect(sent(opened, 'refresh')).toHaveLength(1);
    });
  });

  it('offers no overwrite on a read-only connection', async () => {
    const opened = await open(state({ readOnly: true, conflict: true }));
    expect(opened.requests).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Overwrite with my text' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Load the server value' })).toBeTruthy();
  });
});

describe('etcd key page: a key that is gone', () => {
  it('says so and offers to read again or to create it', async () => {
    const opened = await open(state({ exists: false, value: undefined, modRevision: '0' }));
    expect(screen.getByTestId('gone').textContent).toContain('does not exist');
    await fireEvent.click(screen.getByRole('button', { name: 'Create the key' }));
    await waitFor(() => {
      expect(sent(opened, 'save')).toEqual([{ value: { text: '' }, modRevision: '0' }]);
    });
    // The toolbar has a Refresh icon too; the one in the middle of the page has a word.
    const refresh = screen
      .getAllByRole('button', { name: 'Refresh' })
      .find((button) => button.textContent.includes('Refresh'));
    await fireEvent.click(must(refresh));
    await waitFor(() => {
      expect(sent(opened, 'refresh').length).toBeGreaterThan(0);
    });
  });

  it('does not offer to create it on a read-only connection', async () => {
    await open(state({ exists: false, value: undefined, readOnly: true }));
    expect(screen.queryByRole('button', { name: 'Create the key' })).toBeNull();
  });
});

describe('etcd key page: leases', () => {
  it('shows a key without a lease and attaches a new one by seconds', async () => {
    const opened = await open(state());
    expect(screen.getByTestId('lease').textContent).toContain('No lease');
    const attach = screen.getByRole('button', { name: 'Attach a new lease' });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText('Attach a new lease'), {
      target: { value: '90' },
    });
    await fireEvent.click(attach);
    await waitFor(() => {
      expect(sent(opened, 'attachLease')).toEqual([{ ttl: 90 }]);
    });
  });

  it('attaches by the Enter key as well, and refuses text that is not a number', async () => {
    const opened = await open(state());
    const box = screen.getByLabelText('Attach a new lease');
    await fireEvent.input(box, { target: { value: '9x' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(sent(opened, 'attachLease')).toEqual([]);
    await fireEvent.input(box, { target: { value: '45' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(sent(opened, 'attachLease')).toEqual([{ ttl: 45 }]);
    });
  });

  it('attaches a lease that exists, by its id', async () => {
    const opened = await open(state());
    const box = screen.getByLabelText('Attach by id');
    const button = screen.getByRole('button', { name: 'Attach by id' });
    await fireEvent.input(box, { target: { value: '0xabc' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(box, { target: { value: '7587862219395031808' } });
    await fireEvent.click(button);
    await waitFor(() => {
      expect(sent(opened, 'attachLease')).toEqual([{ id: '7587862219395031808' }]);
    });
    await fireEvent.input(box, { target: { value: '55' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(sent(opened, 'attachLease')).toHaveLength(2);
    });
  });

  it('shows the lease with its id and the time left, counting down', async () => {
    vi.useFakeTimers();
    const opened = await open(
      state({ lease: { id: '7587862219395031808', ttl: 3700, grantedTtl: 4000 } }),
    );
    const badge = screen.getByTestId('lease-badge');
    expect(badge.textContent.trim()).toBe('Lease: 01:01:40 left');
    expect(badge.className).toContain('ok');
    expect(screen.getByTestId('lease').textContent).toContain('7587862219395031808');
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByTestId('lease-badge').textContent.trim()).toBe('Lease: 01:01:35 left');
    expect(opened.requests).toEqual([]);
  });

  it('turns amber in the last minute and red when it has ended', async () => {
    vi.useFakeTimers();
    await open(state({ lease: { id: '5', ttl: 3, grantedTtl: 60 } }));
    expect(screen.getByTestId('lease-badge').className).toContain('soon');
    await vi.advanceTimersByTimeAsync(4000);
    expect(screen.getByTestId('lease-badge').className).toContain('ended');
    expect(screen.getByTestId('lease-badge').textContent.trim()).toBe('Lease ended');
  });

  it('shows a lease the cluster no longer knows as ended', async () => {
    await open(state({ lease: { id: '5', ttl: -1, grantedTtl: 0 } }));
    expect(screen.getByTestId('lease-badge').textContent.trim()).toBe('Lease ended');
  });

  it('lets go of the lease or revokes it', async () => {
    const opened = await open(state({ lease: { id: '5', ttl: 300, grantedTtl: 300 } }));
    await fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    await waitFor(() => {
      expect(sent(opened, 'detachLease')).toHaveLength(1);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => {
      expect(sent(opened, 'revokeLease')).toHaveLength(1);
    });
    expect(screen.queryByPlaceholderText('seconds')).toBeNull();
  });

  it('offers no change of the lease on a read-only connection', async () => {
    await open(state({ readOnly: true, lease: { id: '5', ttl: 300, grantedTtl: 300 } }));
    expect(screen.queryByRole('button', { name: 'Detach' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});

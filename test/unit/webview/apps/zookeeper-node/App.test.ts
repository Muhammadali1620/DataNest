import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  type ZookeeperNodeProtocol,
  zookeeperNodeProtocol,
  type ZookeeperNodeState,
} from '../../../../../src/shared/protocols/zookeeper-node';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/zookeeper-node/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ZookeeperNodeProtocol['host'], ZookeeperNodeProtocol['webview']>;

function state(overrides: Partial<ZookeeperNodeState> = {}): ZookeeperNodeState {
  return {
    path: '/app/config',
    connectionName: 'Ensemble',
    readOnly: false,
    exists: true,
    value: { text: 'hello' },
    size: 5,
    kind: 'persistent',
    version: 3,
    cversion: 2,
    aversion: 1,
    czxid: '4294967297',
    mzxid: '4294967298',
    pzxid: '4294967299',
    ephemeralOwner: '0',
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_100_000,
    numChildren: 2,
    acl: [{ perms: 31, scheme: 'world', id: 'anyone' }],
    children: ['db', 'name'],
    moreChildren: false,
    ...overrides,
  };
}

interface Opened {
  host: HostPeer;
  requests: { method: string; params: unknown }[];
}

async function open(
  initial: ZookeeperNodeState,
  language: 'en' | 'ru' = 'en',
  answers: Record<string, unknown> = {},
): Promise<Opened> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: zookeeperNodeProtocol.host,
    remote: zookeeperNodeProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: zookeeperNodeProtocol.webview,
    remote: zookeeperNodeProtocol.host,
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
  host.handle('createChild', reply('createChild', { path: '/app/config/x' }));
  host.handle('openChild', reply('openChild', {}));
  host.handle('deleteNode', reply('deleteNode', { deleted: true }));
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

describe('ZooKeeper znode page: the znode', () => {
  it('waits for the host before it shows anything', () => {
    const transports = createLinkedTransports();
    const rpc = new RpcPeer({
      local: zookeeperNodeProtocol.webview,
      remote: zookeeperNodeProtocol.host,
      transport: transports.webview,
    });
    render(App, { props: { rpc, t: createTranslator('en') } });
    expect(screen.getByText('Loading the key…')).toBeTruthy();
    expect(transports.webview.posted.length).toBeGreaterThan(0);
  });

  it('shows the whole path, the kind, the version, the size and the connection', async () => {
    await open(state());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('/app/config');
    const meta = screen.getByTestId('meta').textContent;
    expect(meta).toContain('Version 3');
    expect(meta).toContain('5 bytes');
    expect(meta).toContain('Ensemble');
    expect(screen.getByTestId('kind').textContent).toBe('Persistent');
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('shows the data in the editor', async () => {
    await open(state({ value: { text: 'a value' } }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('a value');
  });

  it('shows the stat with the ids as the server tools print them', async () => {
    await open(state());
    const stat = screen.getByTestId('stat').textContent;
    expect(stat).toContain('0x100000001');
    expect(stat).toContain('0x100000002');
    expect(stat).toContain('0x100000003');
    expect(stat).toContain('cversion');
    expect(stat).not.toContain('session');
  });

  it('names the owner session of an ephemeral znode', async () => {
    await open(state({ kind: 'ephemeral', ephemeralOwner: '72057594037927937' }));
    expect(screen.getByTestId('kind').textContent).toBe('Ephemeral');
    expect(screen.getByTestId('stat').textContent).toContain('0x100000000000001');
    expect(screen.getByTestId('stat').textContent).toContain('session');
  });

  it('shows the kinds a znode can be', async () => {
    const opened = await open(state({ kind: 'container' }));
    expect(screen.getByTestId('kind').textContent).toBe('Container');
    opened.host.emit('state', state({ kind: 'ttl' }));
    await waitFor(() => {
      expect(screen.getByTestId('kind').textContent).toBe('Time to live');
    });
  });

  it('lists the ACL as letters and the scheme with its id', async () => {
    await open(
      state({
        acl: [
          { perms: 31, scheme: 'world', id: 'anyone' },
          { perms: 1, scheme: 'digest', id: 'alice:hash' },
          { perms: 3, scheme: 'auth', id: '' },
        ],
      }),
    );
    const acl = within(screen.getByTestId('acl')).getAllByRole('listitem');
    expect(acl.map((item) => item.textContent)).toEqual([
      'rwcdaworld:anyone',
      'r----digest:alice:hash',
      'rw---auth:',
    ]);
  });

  it('says when the ACL could not be read', async () => {
    await open(state({ acl: [] }));
    expect(screen.getByTestId('acl-empty')).toBeTruthy();
  });

  it('lists the children, which open on a click', async () => {
    const opened = await open(state());
    const children = within(screen.getByTestId('children')).getAllByRole('button');
    expect(children.map((item) => item.textContent)).toEqual(['db', 'name']);
    await fireEvent.click(must(children[1]));
    await waitFor(() => {
      expect(sent(opened, 'openChild')).toEqual([{ name: 'name' }]);
    });
  });

  it('says there are no children, and when the list was cut', async () => {
    const opened = await open(state({ children: [], numChildren: 0 }));
    expect(screen.queryByTestId('children')).toBeNull();
    expect(screen.getByText('No children')).toBeTruthy();
    opened.host.emit('state', state({ numChildren: 900, moreChildren: true }));
    await waitFor(() => {
      expect(screen.getByText('Only the first 2 are listed')).toBeTruthy();
    });
  });

  it('is in Russian when asked', async () => {
    await open(state(), 'ru');
    expect(screen.getByTestId('meta').textContent).toContain('Версия 3');
    expect(screen.getByTestId('kind').textContent).toBe('Постоянный');
    expect(screen.getByText('Потомки (2)')).toBeTruthy();
  });

  it('says a read-only connection is read-only and offers no change', async () => {
    await open(state({ readOnly: true }));
    expect(screen.getByTestId('meta').textContent).toContain('read-only');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the znode' })).toBeNull();
    expect(screen.queryByTestId('add-child')).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value').readOnly).toBe(true);
  });

  it('does not offer to delete the root', async () => {
    await open(state({ path: '/' }));
    expect(screen.queryByRole('button', { name: 'Delete the znode' })).toBeNull();
  });

  it('does not offer to save a value that was cut', async () => {
    await open(state({ value: { text: 'a', truncated: true, size: 2_000_000 } }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('says the data cannot be read when the ACL forbids it, and shows no stat', async () => {
    await open(state({ value: undefined, denied: true }));
    expect(screen.getByTestId('denied')).toBeTruthy();
    expect(screen.queryByTestId('stat')).toBeNull();
    expect(screen.queryByLabelText('Value')).toBeNull();
  });

  it('refreshes, copies the path and deletes on request', async () => {
    const opened = await open(state());
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(sent(opened, 'refresh')).toHaveLength(1);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy the path' }));
    await waitFor(() => {
      expect(sent(opened, 'copyText')).toEqual([{ text: '/app/config' }]);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete the znode' }));
    await waitFor(() => {
      expect(sent(opened, 'deleteNode')).toHaveLength(1);
    });
  });

  it('shows what the host refused', async () => {
    await open(state(), 'en', { deleteNode: new Error('Not allowed') });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete the znode' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('Not allowed');
    });
  });
});

describe('ZooKeeper znode page: saving', () => {
  it('keeps Save off until the text changes, then sends it with the version it read', async () => {
    const opened = await open(state());
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'changed' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => {
      expect(sent(opened, 'save')).toEqual([{ value: { text: 'changed' }, version: 3 }]);
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

  it('takes the server data when a fresh state arrives without a conflict', async () => {
    const opened = await open(state());
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'my draft' } });
    opened.host.emit('state', state({ value: { text: 'server value' }, version: 4 }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('server value');
    });
  });
});

describe('ZooKeeper znode page: a conflict', () => {
  async function conflict(): Promise<Opened> {
    const opened = await open(state());
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'my draft' } });
    opened.host.emit('state', state({ value: { text: 'theirs' }, version: 5, conflict: true }));
    await waitFor(() => {
      expect(screen.queryByTestId('conflict')).not.toBeNull();
    });
    return opened;
  }

  it('keeps the text the user typed and says which version the znode is at', async () => {
    await conflict();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('my draft');
    expect(screen.getByTestId('conflict').textContent).toContain('version 5');
  });

  it('loads the server data on request', async () => {
    const opened = await conflict();
    await fireEvent.click(screen.getByRole('button', { name: 'Load the server data' }));
    await waitFor(() => {
      expect(sent(opened, 'refresh')).toHaveLength(1);
    });
  });

  it('overwrites on purpose with the text the user typed', async () => {
    const opened = await conflict();
    await fireEvent.click(screen.getByRole('button', { name: 'Overwrite with my text' }));
    await waitFor(() => {
      expect(sent(opened, 'save')).toEqual([
        { value: { text: 'my draft' }, version: 5, overwrite: true },
      ]);
    });
  });

  it('offers no overwrite on a read-only connection', async () => {
    const opened = await open(state({ readOnly: true }));
    opened.host.emit('state', state({ readOnly: true, conflict: true }));
    await waitFor(() => {
      expect(screen.queryByTestId('conflict')).not.toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Overwrite with my text' })).toBeNull();
  });
});

describe('ZooKeeper znode page: a znode that is not there', () => {
  it('says so and offers to create it', async () => {
    const opened = await open(state({ exists: false, value: undefined, children: [], acl: [] }));
    expect(screen.getByTestId('gone')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Create the znode' }));
    await waitFor(() => {
      expect(sent(opened, 'save')).toEqual([{ value: { text: '' }, version: 0 }]);
    });
  });

  it('offers a read-only connection nothing but a refresh', async () => {
    await open(state({ exists: false, value: undefined, readOnly: true }));
    expect(screen.queryByRole('button', { name: 'Create the znode' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0);
  });
});

describe('ZooKeeper znode page: a new child', () => {
  it('is not offered below an ephemeral znode, which cannot have children', async () => {
    await open(state({ kind: 'ephemeral', ephemeralOwner: '72057594037927937' }));
    expect(screen.queryByTestId('add-child')).toBeNull();
  });

  it('sends the name and the way the child lives', async () => {
    const opened = await open(state());
    const name = screen.getByLabelText('New child');
    const add = screen.getByRole('button', { name: 'Add' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(name, { target: { value: ' job- ' } });
    await fireEvent.change(screen.getByLabelText('How the child lives'), {
      target: { value: 'sequential' },
    });
    await fireEvent.click(add);
    await waitFor(() => {
      expect(sent(opened, 'createChild')).toEqual([{ name: 'job-', mode: 'sequential' }]);
    });
    await waitFor(() => {
      expect((name as HTMLInputElement).value).toBe('');
    });
  });

  it('adds on Enter', async () => {
    const opened = await open(state());
    const name = screen.getByLabelText('New child');
    await fireEvent.input(name, { target: { value: 'kid' } });
    await fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => {
      expect(sent(opened, 'createChild')).toEqual([{ name: 'kid', mode: 'persistent' }]);
    });
  });

  it('keeps the name when the host refuses', async () => {
    await open(state(), 'en', { createChild: new Error('The znode already exists') });
    const name = screen.getByLabelText('New child');
    await fireEvent.input(name, { target: { value: 'db' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('already exists');
    });
    expect((name as HTMLInputElement).value).toBe('db');
  });
});

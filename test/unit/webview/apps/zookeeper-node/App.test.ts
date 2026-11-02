import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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
  host.handle('saveAcl', reply('saveAcl', { saved: true }));
  host.handle('createChild', reply('createChild', { path: '/app/config/x' }));
  host.handle('openChild', reply('openChild', {}));
  host.handle('deleteNode', reply('deleteNode', { deleted: true }));
  host.handle('watch', reply('watch', {}));
  host.handle('clearEvents', reply('clearEvents', {}));
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

describe('ZooKeeper znode page: the ACL editor (V13.27)', () => {
  const editButton = (): HTMLElement => screen.getByRole('button', { name: 'Edit the ACL' });

  it('is offered next to the ACL, and not on a read-only connection or when the ACL is unknown', async () => {
    await open(state());
    expect(screen.queryByRole('button', { name: 'Edit the ACL' })).not.toBeNull();
    cleanup();
    await open(state({ readOnly: true }));
    expect(screen.queryByRole('button', { name: 'Edit the ACL' })).toBeNull();
    cleanup();
    await open(state({ acl: [] }));
    expect(screen.queryByRole('button', { name: 'Edit the ACL' })).toBeNull();
  });

  it('opens on the ACL as it is, with the permissions ticked', async () => {
    await open(
      state({
        acl: [
          { perms: 17, scheme: 'digest', id: 'alice:hash' },
          { perms: 1, scheme: 'world', id: 'anyone' },
        ],
      }),
    );
    await fireEvent.click(editButton());
    const editor = within(screen.getByTestId('acl-editor'));
    const ids = editor.getAllByLabelText<HTMLInputElement>('Id');
    expect(ids.map((box) => box.value)).toEqual(['alice:hash', 'anyone']);
    const reads = editor.getAllByLabelText<HTMLInputElement>('Read');
    expect(reads.map((box) => box.checked)).toEqual([true, true]);
    const admins = editor.getAllByLabelText<HTMLInputElement>('Administer (change the ACL)');
    expect(admins.map((box) => box.checked)).toEqual([true, false]);
  });

  it('sends the edited entries with the ACL version it read', async () => {
    const opened = await open(state());
    await fireEvent.click(editButton());
    const editor = within(screen.getByTestId('acl-editor'));
    await fireEvent.click(editor.getByLabelText('Delete children'));
    await fireEvent.click(editor.getByRole('button', { name: 'Add an entry' }));
    const ids = editor.getAllByLabelText<HTMLInputElement>('Id');
    await fireEvent.input(must(ids[1]), { target: { value: 'bob:pw' } });
    await fireEvent.click(editor.getByRole('button', { name: 'Save the ACL' }));
    await waitFor(() => {
      expect(sent(opened, 'saveAcl')).toHaveLength(1);
    });
    expect(sent(opened, 'saveAcl')[0]).toEqual({
      aversion: 1,
      acl: [
        { perms: 23, scheme: 'world', id: 'anyone' },
        { perms: 1, scheme: 'digest', id: 'bob:pw' },
      ],
    });
  });

  it('keeps Save off while an entry is not valid, and gives a scheme with a fixed id its id', async () => {
    await open(state());
    await fireEvent.click(editButton());
    const editor = within(screen.getByTestId('acl-editor'));
    await fireEvent.click(editor.getByRole('button', { name: 'Add an entry' }));
    const save = editor.getByRole('button', { name: 'Save the ACL' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const schemes = editor.getAllByLabelText<HTMLSelectElement>('Scheme');
    await fireEvent.change(must(schemes[1]), { target: { value: 'auth' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(editor.getAllByLabelText<HTMLInputElement>('Id')[1]?.disabled).toBe(true);
    await fireEvent.change(must(schemes[1]), { target: { value: 'world' } });
    expect(editor.getAllByLabelText<HTMLInputElement>('Id')[1]?.value).toBe('anyone');
  });

  it('cannot remove the last entry, and removes another one', async () => {
    await open(state());
    await fireEvent.click(editButton());
    const editor = within(screen.getByTestId('acl-editor'));
    expect(
      editor.getByRole<HTMLButtonElement>('button', { name: 'Remove the entry' }).disabled,
    ).toBe(true);
    await fireEvent.click(editor.getByRole('button', { name: 'Add an entry' }));
    await fireEvent.click(must(editor.getAllByRole('button', { name: 'Remove the entry' })[1]));
    expect(editor.getAllByLabelText('Id')).toHaveLength(1);
  });

  it('closes on Cancel without sending anything, and when a fresh state arrives', async () => {
    const opened = await open(state());
    await fireEvent.click(editButton());
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('acl-editor')).toBeNull();
    expect(sent(opened, 'saveAcl')).toHaveLength(0);
    await fireEvent.click(editButton());
    expect(screen.queryByTestId('acl-editor')).not.toBeNull();
    opened.host.emit('state', state({ aversion: 2 }));
    await waitFor(() => {
      expect(screen.queryByTestId('acl-editor')).toBeNull();
    });
  });

  it('says the ACL changed meanwhile, and shows the one that is there now', async () => {
    await open(
      state({ aclConflict: true, aversion: 4, acl: [{ perms: 1, scheme: 'world', id: 'anyone' }] }),
    );
    expect(screen.getByTestId('acl-conflict').textContent).toContain('version 4');
    expect(screen.getByTestId('acl').textContent).toContain('r----');
  });

  it('shows what the host refused', async () => {
    await open(state(), 'en', { saveAcl: new Error('The ACL is invalid') });
    await fireEvent.click(editButton());
    await fireEvent.click(screen.getByRole('button', { name: 'Save the ACL' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('The ACL is invalid');
    });
  });

  it('speaks Russian', async () => {
    await open(state(), 'ru');
    await fireEvent.click(screen.getByRole('button', { name: 'Изменить ACL' }));
    expect(screen.getByRole('button', { name: 'Сохранить ACL' })).toBeTruthy();
  });
});

describe('ZooKeeper znode page: watching', () => {
  const change = (kind: 'created' | 'deleted' | 'data' | 'children', version = 4) => ({
    at: new Date(2026, 0, 2, 14, 3, 9).getTime(),
    kind,
    version,
    size: 7,
    children: 2,
  });

  it('offers to watch, and asks the host to start', async () => {
    const opened = await open(state());
    expect(screen.queryByTestId('changes')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    await waitFor(() => {
      expect(sent(opened, 'watch')).toEqual([{ on: true }]);
    });
  });

  it('shows that it is watching, and asks the host to stop', async () => {
    const opened = await open(state({ watching: true }));
    expect(screen.getByRole('button', { name: 'Stop watching' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByTestId('watch-note').textContent).toContain('waiting for changes');
    await fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    await waitFor(() => {
      expect(sent(opened, 'watch')).toEqual([{ on: false }]);
    });
  });

  it('lists the changes, the newest first, with what the znode looked like after them', async () => {
    await open(state({ watching: true, events: [change('data', 3), change('children', 4)] }));
    const rows = screen.getAllByRole('listitem').filter((row) => row.classList.contains('change'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Children changed');
    expect(rows[0]?.textContent).toContain('Version 4');
    expect(rows[0]?.textContent).toContain('7 bytes');
    expect(rows[0]?.textContent).toContain('14:03:09');
    expect(rows[1]?.textContent).toContain('Data changed');
    expect(screen.getByTestId('watch-note').textContent).toContain('listed below');
    expect(screen.getByTestId('changes').textContent).toContain('Changes · 2');
  });

  it('names created and deleted, and gives a deleted znode no numbers', async () => {
    await open(state({ events: [change('created'), change('deleted')] }));
    const rows = screen.getAllByRole('listitem').filter((row) => row.classList.contains('change'));
    expect(rows[0]?.textContent).toContain('Deleted');
    expect(rows[0]?.textContent).not.toContain('bytes');
    expect(rows[1]?.textContent).toContain('Created');
  });

  it('keeps the list after the watch stops, and says why it stopped', async () => {
    await open(
      state({ events: [change('data')], watchNotice: 'Watching stopped: the session ended' }),
    );
    expect(screen.getByTestId('changes')).toBeTruthy();
    expect(screen.getByTestId('watch-notice').textContent).toContain('the session ended');
    expect(screen.getByRole('button', { name: 'Watch' })).toBeTruthy();
  });

  it('clears the list', async () => {
    const opened = await open(state({ events: [change('data')] }));
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(sent(opened, 'clearEvents')).toHaveLength(1);
    });
  });

  it('can watch a znode that is not there yet', async () => {
    const opened = await open(state({ exists: false, value: undefined }));
    await fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    await waitFor(() => {
      expect(sent(opened, 'watch')).toHaveLength(1);
    });
  });

  it('keeps what the user is typing when the watch brings a change, and warns', async () => {
    const opened = await open(state({ watching: true }));
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'my draft' } });
    opened.host.emit('state', state({ watching: true, version: 6, value: { text: 'theirs' } }));
    await waitFor(() => {
      expect(screen.queryByTestId('stale')).not.toBeNull();
    });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('my draft');
    expect(screen.getByTestId('stale').textContent).toContain('version 6');
    // The save is checked against the version the box was filled at, so the host refuses it.
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent(opened, 'save')).toEqual([{ value: { text: 'my draft' }, version: 3 }]);
    });
  });

  it('shows the new data at once when the user has typed nothing', async () => {
    const opened = await open(state({ watching: true }));
    opened.host.emit('state', state({ watching: true, version: 6, value: { text: 'theirs' } }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Value').value).toBe('theirs');
    });
    expect(screen.queryByTestId('stale')).toBeNull();
  });

  it('speaks Russian', async () => {
    await open(state({ watching: true, events: [change('children')] }), 'ru');
    expect(screen.getByRole('button', { name: 'Не следить' })).toBeTruthy();
    expect(screen.getByTestId('changes').textContent).toContain('Изменения');
    expect(screen.getByTestId('changes').textContent).toContain('Потомки изменены');
  });
});

describe('ZooKeeper znode page: the ACL below (V13.31)', () => {
  const editButton = () => screen.getByRole('button', { name: 'Edit the ACL' });

  it('offers the box when the znode has children, and sends the flag when it is ticked', async () => {
    const opened = await open(state({ numChildren: 4 }));
    await fireEvent.click(editButton());
    const editor = within(screen.getByTestId('acl-editor'));
    expect(editor.getByTestId('acl-recursive').parentElement?.textContent).toContain(
      'Give the same ACL to the 4 znodes below, too',
    );
    await fireEvent.click(editor.getByTestId('acl-recursive'));
    await fireEvent.click(editor.getByRole('button', { name: 'Save the ACL' }));
    await waitFor(() => {
      expect(sent(opened, 'saveAcl')).toHaveLength(1);
    });
    expect(sent(opened, 'saveAcl')[0]).toMatchObject({ aversion: 1, recursive: true });
  });

  it('sends no flag when the box stays empty', async () => {
    const opened = await open(state({ numChildren: 4 }));
    await fireEvent.click(editButton());
    await fireEvent.click(
      within(screen.getByTestId('acl-editor')).getByRole('button', { name: 'Save the ACL' }),
    );
    await waitFor(() => {
      expect(sent(opened, 'saveAcl')).toHaveLength(1);
    });
    expect(sent(opened, 'saveAcl')[0]).not.toHaveProperty('recursive');
  });

  it('offers no box for a znode without children', async () => {
    await open(state({ numChildren: 0, children: [] }));
    await fireEvent.click(editButton());
    expect(screen.queryByTestId('acl-recursive')).toBeNull();
  });

  it('says how many znodes below got the ACL', async () => {
    await open(state({ aclTree: { changed: 7, failed: 0, failures: [], capped: false } }));
    const note = screen.getByTestId('acl-tree');
    expect(note.textContent).toContain('The ACL was given to 7 znodes below.');
    expect(note.classList.contains('warning')).toBe(false);
  });

  it('lists the znodes that refused, and says when the walk was cut', async () => {
    await open(
      state({
        aclTree: {
          changed: 5,
          failed: 2,
          failures: ['/a/b: not allowed', '/a/c: not allowed'],
          capped: true,
        },
      }),
    );
    const note = screen.getByTestId('acl-tree');
    expect(note.classList.contains('warning')).toBe(true);
    expect(note.textContent).toContain('2 could not be changed:');
    expect(note.textContent).toContain('/a/b: not allowed; /a/c: not allowed');
    expect(note.textContent).toContain('stopped at its limit');
  });

  it('is not shown when nothing was done below', async () => {
    await open(state());
    expect(screen.queryByTestId('acl-tree')).toBeNull();
  });

  it('speaks Russian', async () => {
    await open(
      state({ numChildren: 4, aclTree: { changed: 7, failed: 0, failures: [], capped: false } }),
      'ru',
    );
    expect(screen.getByTestId('acl-tree').textContent).toContain('ACL выдан узлам ниже: 7.');
  });
});

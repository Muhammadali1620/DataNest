// The Servers view (V13.16): what it lists, how it draws it, what a drop does — over real
// sessions on an SSH server inside the test process.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  folderOf,
  isServerNode,
  type ServerNode,
  SERVERS_MIME,
  ServersTree,
} from '../../../../src/vscode/servers/servers-tree';
import { MemorySftpFs } from '../../../helpers/memory-sftp';
import { must } from '../../../helpers/must';
import { type ServerWorld, startServerWorld } from '../../../helpers/sftp-fixture';
import * as stub from '../../../helpers/vscode-stub';

vi.mock('vscode', () => import('../../../helpers/vscode-stub'));

let world: ServerWorld;
let fs: MemorySftpFs;
let tree: ServersTree;
let showHidden: boolean;
let drops: { target: ServerNode | undefined; paths: readonly string[] }[];
let moves: { target: ServerNode | undefined; entries: readonly ServerNode[] }[];

beforeEach(async () => {
  fs = new MemorySftpFs();
  fs.file('/home/deploy/notes.txt', 'n')
    .file('/home/deploy/.bashrc', 'rc')
    .file('/home/deploy/app/main.ts', 'm')
    .folder('/home/deploy/empty')
    .file('/home/deploy/file10', '')
    .file('/home/deploy/file2', '')
    .file('/srv/www/index.html', '<html>')
    .link('/home/deploy/ln', '/home/deploy/notes.txt')
    .folder('/locked')
    .deny('/locked');
  world = await startServerWorld(fs);
  showHidden = true;
  drops = [];
  moves = [];
  tree = new ServersTree({
    store: world.store,
    hub: world.hub,
    showHidden: () => showHidden,
    onDropFiles: (target, paths) => {
      drops.push({ target, paths });
      return Promise.resolve();
    },
    onMoveEntries: (target, entries) => {
      moves.push({ target, entries });
      return Promise.resolve();
    },
  });
});

afterEach(async () => {
  tree.dispose();
  await world.shutdown();
});

const server = (serverId: string): ServerNode => ({ kind: 'server', serverId });

async function names(node: ServerNode): Promise<string[]> {
  return (await tree.getChildren(node)).map((child) => {
    const item = tree.getTreeItem(child);
    return typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
  });
}

describe('the roots', () => {
  it('lists the saved servers', async () => {
    const roots = await tree.getChildren();
    expect(roots).toEqual([server(world.serverId), server(world.readOnlyId)]);
  });

  it('lists none when there are none', async () => {
    await world.store.remove(world.serverId);
    await world.store.remove(world.readOnlyId);
    expect(await tree.getChildren()).toEqual([]);
  });
});

describe('a server', () => {
  it('lists the login folder: folders first, names in a natural order, links as what they lead to', async () => {
    expect(await names(server(world.serverId))).toEqual([
      'app',
      'empty',
      '.bashrc',
      'file2',
      'file10',
      'ln',
      'notes.txt',
    ]);
  });

  it('leaves hidden files out when asked to', async () => {
    showHidden = false;
    expect(await names(server(world.serverId))).not.toContain('.bashrc');
  });

  it('starts in the start folder when the server has one', async () => {
    const withStart = await world.store.add(
      {
        name: 'Site',
        startPath: '/srv/www',
        ssh: {
          id: 'main',
          host: '127.0.0.1',
          port: world.server.port,
          user: 'deploy',
          auth: 'password',
        },
      },
      { main: { password: 'pw' } },
    );
    expect(await names(server(withStart.id))).toEqual(['index.html']);
  });

  it('says what is wrong when it cannot be reached, instead of failing the tree', async () => {
    const lost = await world.store.add({
      name: 'Lost',
      ssh: { id: 'main', host: '127.0.0.1', port: 1, user: 'u', auth: 'password' },
    });
    const children = await tree.getChildren(server(lost.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: 'message', failed: true });
  });

  it('draws a server with its address, its state and its mark', async () => {
    const item = tree.getTreeItem(server(world.serverId));
    expect(item.label).toBe('Web');
    expect(item.description).toBe(`deploy@127.0.0.1:${world.server.port}`);
    expect(item.contextValue).toBe('datanest.server');
    expect((item.iconPath as stub.ThemeIcon).id).toBe('vm');
    await tree.getChildren(server(world.serverId));
    const open = tree.getTreeItem(server(world.serverId));
    expect(open.contextValue).toBe('datanest.server.open');
    expect((open.iconPath as stub.ThemeIcon).id).toBe('vm-active');
    expect((open.iconPath as stub.ThemeIcon).color?.id).toBe('charts.green');
  });

  it('says "Read-only" on a read-only server', () => {
    expect(tree.getTreeItem(server(world.readOnlyId)).description).toMatch(/^Read-only · /u);
  });

  it('draws the colour the server was given when it is not connected', async () => {
    const coloured = await world.store.add({
      name: 'Red',
      color: 'red',
      ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' },
    });
    expect((tree.getTreeItem(server(coloured.id)).iconPath as stub.ThemeIcon).color?.id).toBe(
      'charts.red',
    );
  });
});

describe('folders and files', () => {
  it('opens a folder lazily, with its own children', async () => {
    const roots = await tree.getChildren(server(world.serverId));
    const app = roots.find((node) => node.kind === 'entry' && node.entry.name === 'app');
    expect(app).toBeDefined();
    expect(await names(must(app))).toEqual(['main.ts']);
  });

  it('says a folder is empty', async () => {
    const roots = await tree.getChildren(server(world.serverId));
    const empty = roots.find((node) => node.kind === 'entry' && node.entry.name === 'empty');
    const children = await tree.getChildren(empty);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: 'message', failed: false });
    expect(tree.getTreeItem(must(children[0])).label).toBe('This folder is empty');
  });

  it('says why a folder cannot be read', async () => {
    const node: ServerNode = {
      kind: 'entry',
      serverId: world.serverId,
      entry: {
        name: 'locked',
        path: '/locked',
        kind: 'directory',
        link: false,
        size: 0,
        modified: 0,
        mode: 0o40755,
      },
    };
    const children = await tree.getChildren(node);
    expect(children[0]).toMatchObject({ kind: 'message', failed: true });
    expect(tree.getTreeItem(must(children[0])).label).toMatch(/No permission/u);
  });

  it('draws a file with an icon of its kind, size, permissions, and a click that opens it', async () => {
    const roots = await tree.getChildren(server(world.serverId));
    const notes = roots.find((node) => node.kind === 'entry' && node.entry.name === 'notes.txt');
    const item = tree.getTreeItem(must(notes));
    expect(item.label).toBe('notes.txt');
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.None);
    expect(item.contextValue).toBe('datanest.sftpFile');
    expect(item.description).toMatch(/^1 B · rw-r--r--/u);
    expect((item.iconPath as stub.ThemeIcon).id).toBe('file-text');
    expect(item.command?.command).toBe('datanest.sftp.open');
    expect(item.command?.arguments?.[0]).toBe(notes);
  });

  it('names the owner in the tooltip by the files of the server', async () => {
    fs.file('/etc/passwd', 'deploy:x:1000:1000::/h:/bin/sh\n').file(
      '/etc/group',
      'staff:x:1000:\n',
    );
    const roots = await tree.getChildren(server(world.serverId));
    const notes = roots.find((node) => node.kind === 'entry' && node.entry.name === 'notes.txt');
    const tooltip = tree.getTreeItem(must(notes)).tooltip as stub.MarkdownString;
    expect(tooltip.value).toContain('deploy:staff');
  });

  it('shows the owner as numbers when the server has no names, and still lists the folder', async () => {
    const roots = await tree.getChildren(server(world.serverId));
    expect(roots.length).toBeGreaterThan(0);
    const notes = roots.find((node) => node.kind === 'entry' && node.entry.name === 'notes.txt');
    const tooltip = tree.getTreeItem(must(notes)).tooltip as stub.MarkdownString;
    expect(tooltip.value).toContain('1000:1000');
  });

  it('draws a folder that opens and does not click through', async () => {
    const roots = await tree.getChildren(server(world.serverId));
    const app = roots.find((node) => node.kind === 'entry' && node.entry.name === 'app');
    const item = tree.getTreeItem(must(app));
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.Collapsed);
    expect(item.contextValue).toBe('datanest.sftpDir');
    expect(item.command).toBeUndefined();
    expect((item.iconPath as stub.ThemeIcon).id).toBe('folder');
  });

  it('marks the context of what lies on a read-only server', async () => {
    const roots = await tree.getChildren(server(world.readOnlyId));
    const contexts = roots.map((node) => tree.getTreeItem(node).contextValue);
    expect(contexts.every((context) => context?.endsWith('.ro'))).toBe(true);
  });

  it('gives a node its own id on each server', async () => {
    const a = must((await tree.getChildren(server(world.serverId)))[0]);
    const b = must((await tree.getChildren(server(world.readOnlyId)))[0]);
    expect(tree.getTreeItem(a).id).not.toBe(tree.getTreeItem(b).id);
  });

  it('has no children under a file or a message', async () => {
    const roots = await tree.getChildren(server(world.serverId));
    const notes = roots.find((node) => node.kind === 'entry' && node.entry.name === 'notes.txt');
    expect(await tree.getChildren(notes)).toEqual([]);
    const message: ServerNode = {
      kind: 'message',
      serverId: 'x',
      under: '',
      text: 't',
      failed: false,
    };
    expect(await tree.getChildren(message)).toEqual([]);
  });
});

describe('refresh', () => {
  it('tells the view to draw a node again, or everything', () => {
    const seen: (ServerNode | undefined)[] = [];
    tree.onDidChangeTreeData((node) => seen.push(node));
    const node = server(world.serverId);
    tree.refresh(node);
    tree.refresh();
    expect(seen).toEqual([node, undefined]);
  });

  it('draws everything again when a server is saved or a session opens', async () => {
    let fired = 0;
    tree.onDidChangeTreeData(() => {
      fired += 1;
    });
    await world.store.setReadOnly(world.serverId, true);
    expect(fired).toBe(1);
    await world.hub.session(world.serverId);
    expect(fired).toBeGreaterThan(1);
  });
});

describe('folderOf', () => {
  it('says where a node lies: a folder is itself, a file is its folder, a server its start', () => {
    const entry = (path: string, kind: 'file' | 'directory'): ServerNode => ({
      kind: 'entry',
      serverId: 's',
      entry: { name: 'x', path, kind, link: false, size: 0, modified: 0, mode: 0 },
    });
    expect(folderOf(entry('/a/b', 'directory'))).toEqual({ serverId: 's', path: '/a/b' });
    expect(folderOf(entry('/a/b/c.txt', 'file'))).toEqual({ serverId: 's', path: '/a/b' });
    expect(folderOf({ kind: 'server', serverId: 's' })).toEqual({
      serverId: 's',
      path: undefined,
    });
  });

  it('knows a node from other values', () => {
    expect(isServerNode(server('s'))).toBe(true);
    expect(isServerNode({ kind: 'other' })).toBe(false);
    expect(isServerNode(undefined)).toBe(false);
    expect(isServerNode('text')).toBe(false);
  });
});

describe('dropping files from the explorer', () => {
  const transfer = (text: string | undefined): never =>
    ({
      get: (mime: string) =>
        mime === 'text/uri-list' && text !== undefined
          ? { asString: () => Promise.resolve(text) }
          : undefined,
    }) as never;

  it('hands the files of this machine to the upload, with the node they landed on', async () => {
    const target = server(world.serverId);
    await tree.handleDrop(
      target,
      transfer('file:///home/me/a.txt\r\n# a comment\r\nfile:///home/me/b%20c.txt\r\n\r\n'),
    );
    expect(drops).toEqual([{ target, paths: ['/home/me/a.txt', '/home/me/b c.txt'] }]);
  });

  it('ignores addresses that are not files of this machine', async () => {
    await tree.handleDrop(
      server(world.serverId),
      transfer('https://example.com/x\r\ndatanest-sftp://s/a\r\nnot an address'),
    );
    expect(drops).toEqual([]);
  });

  it('does nothing without a list of addresses', async () => {
    await tree.handleDrop(server(world.serverId), transfer(undefined));
    expect(drops).toEqual([]);
  });

  it('passes a drop on empty space on, with no target', async () => {
    await tree.handleDrop(undefined, transfer('file:///x.txt'));
    expect(drops[0]?.target).toBeUndefined();
  });

  it('accepts lists of addresses and items of the tree itself', () => {
    expect(SERVERS_MIME).toBe('application/vnd.code.tree.datanest.servers');
    expect(tree.dropMimeTypes).toEqual(['text/uri-list', SERVERS_MIME]);
    expect(tree.dragMimeTypes).toEqual([SERVERS_MIME]);
  });
});

describe('dragging inside the tree', () => {
  const entryNode = (path: string): ServerNode => ({
    kind: 'entry',
    serverId: world.serverId,
    entry: {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      kind: 'file',
      link: false,
      size: 1,
      modified: 0,
      mode: 0o100644,
    },
  });

  class Transfer {
    readonly items = new Map<string, { value: unknown }>();
    set(mime: string, item: { value: unknown }): void {
      this.items.set(mime, item);
    }
    get(mime: string): { value: unknown } | undefined {
      return this.items.get(mime);
    }
  }

  it('offers the files and folders being dragged, and leaves servers and messages out', () => {
    const transfer = new Transfer();
    const a = entryNode('/home/deploy/notes.txt');
    tree.handleDrag([a, server(world.serverId)], transfer as never);
    expect(transfer.get(SERVERS_MIME)?.value).toEqual([a]);
    const none = new Transfer();
    tree.handleDrag([server(world.serverId)], none as never);
    expect(none.items.size).toBe(0);
  });

  it('passes what was dropped on, with the node it landed on', async () => {
    const transfer = new Transfer();
    const a = entryNode('/home/deploy/notes.txt');
    tree.handleDrag([a], transfer as never);
    const target = server(world.serverId);
    await tree.handleDrop(target, transfer as never);
    expect(moves).toEqual([{ target, entries: [a] }]);
    expect(drops).toEqual([]);
  });

  it('ignores a drop of something that is not a list of tree items', async () => {
    const transfer = new Transfer();
    transfer.set(SERVERS_MIME, { value: [{ kind: 'server', serverId: 's' }, 'text'] });
    await tree.handleDrop(server(world.serverId), transfer as never);
    expect(moves).toEqual([]);
    expect(drops).toEqual([]);
  });

  it('does not fail where nobody listens for moves', async () => {
    const lonely = new ServersTree({
      store: world.store,
      hub: world.hub,
      showHidden: () => true,
      onDropFiles: () => Promise.resolve(),
    });
    const transfer = new Transfer();
    transfer.set(SERVERS_MIME, { value: [entryNode('/x')] });
    await expect(lonely.handleDrop(undefined, transfer as never)).resolves.toBeUndefined();
    lonely.dispose();
  });
});

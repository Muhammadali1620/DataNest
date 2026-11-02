// The commands of the Servers view (V13.16): what they ask, what they refuse, what they do
// on the server — with the editor's dialogs answered by the test and a real SFTP session.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ServerCommands,
  serverCommandHandlers,
} from '../../../../src/vscode/servers/server-commands';
import { type ServerNode, ServersTree } from '../../../../src/vscode/servers/servers-tree';
import type { SftpEntry } from '../../../../src/services/sftp-types';
import { RecordingLogger } from '../../../helpers/fakes';
import { MemorySftpFs } from '../../../helpers/memory-sftp';
import { type ServerWorld, startServerWorld } from '../../../helpers/sftp-fixture';
import * as stub from '../../../helpers/vscode-stub';

vi.mock('vscode', () => import('../../../helpers/vscode-stub'));

let world: ServerWorld;
let fs: MemorySftpFs;
let tree: ServersTree;
let commands: ServerCommands;
let maxOpen: number;
let refreshes: number;

const window = stub.window;

function file(path: string, serverId = world.serverId, size = 3): ServerNode {
  return entryNode(path, 'file', serverId, size);
}

function folder(path: string, serverId = world.serverId): ServerNode {
  return entryNode(path, 'directory', serverId, 0);
}

function entryNode(
  path: string,
  kind: 'file' | 'directory',
  serverId: string,
  size: number,
): ServerNode {
  const entry: SftpEntry = {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind,
    link: false,
    size,
    modified: 1_700_000_000_000,
    mode: kind === 'file' ? 0o100644 : 0o40755,
  };
  return { kind: 'entry', serverId, entry };
}

const server = (serverId: string): ServerNode => ({ kind: 'server', serverId });

/** A second saved server that leads to the same fixture: its own session, so a move is a copy. */
async function addTwin(): Promise<string> {
  const twin = await world.store.add(
    {
      name: 'Twin',
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
  return twin.id;
}

const run = async (name: keyof ServerCommands['handlers'], ...args: unknown[]): Promise<unknown> =>
  await commands.handlers[name](...args);

beforeEach(async () => {
  stub.resetWindow();
  fs = new MemorySftpFs();
  fs.file('/home/deploy/a.txt', 'aaa')
    .file('/home/deploy/b.txt', 'bbb')
    .file('/home/deploy/dir/c.txt', 'ccc')
    .folder('/dest');
  world = await startServerWorld(fs);
  maxOpen = 1024;
  tree = new ServersTree({
    store: world.store,
    hub: world.hub,
    showHidden: () => true,
    onDropFiles: () => Promise.resolve(),
  });
  refreshes = 0;
  tree.onDidChangeTreeData(() => {
    refreshes += 1;
  });
  commands = serverCommandHandlers({
    store: world.store,
    hub: world.hub,
    tree,
    logger: new RecordingLogger(),
    maxOpenBytes: () => maxOpen,
  });
});

afterEach(async () => {
  tree.dispose();
  await world.shutdown();
});

/** Answers the next input boxes in order. */
function answers(...values: (string | undefined)[]): void {
  for (const value of values) {
    window.showInputBox.mockResolvedValueOnce(value);
  }
}

describe('adding a server', () => {
  it('asks for the login step by step and saves it with the password in the secrets', async () => {
    answers('Staging', 'stage.example.com', '2200', 'deploy', 'pw1', '/var/www');
    window.showQuickPick
      .mockResolvedValueOnce({ auth: 'password' })
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ choice: 'direct' });
    const id = (await run('addServer')) as string;
    const saved = world.store.get(id);
    expect(saved).toMatchObject({
      name: 'Staging',
      startPath: '/var/www',
      readOnly: true,
      ssh: { host: 'stage.example.com', port: 2200, user: 'deploy', auth: 'password' },
    });
    expect(await world.store.getSshSecrets(id)).toEqual({
      [saved?.ssh.id ?? '']: { password: 'pw1' },
    });
    expect(refreshes).toBeGreaterThan(0);
  });

  it('takes a key file and its passphrase', async () => {
    answers('Keyed', 'k.example.com', '22', 'me', '~/.ssh/id_ed25519', 'secret phrase', '');
    window.showQuickPick
      .mockResolvedValueOnce({ auth: 'key' })
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ choice: 'direct' });
    const id = (await run('addServer')) as string;
    const saved = world.store.get(id);
    expect(saved?.ssh).toMatchObject({ auth: 'key', keyFile: '~/.ssh/id_ed25519' });
    expect(saved?.readOnly).toBeUndefined();
    expect(saved?.startPath).toBeUndefined();
    expect(Object.values(await world.store.getSshSecrets(id))[0]).toEqual({
      passphrase: 'secret phrase',
    });
  });

  it('needs no secret for the agent', async () => {
    answers('Agent', 'a.example.com', '22', 'me', '');
    window.showQuickPick
      .mockResolvedValueOnce({ auth: 'agent' })
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ choice: 'direct' });
    const id = (await run('addServer')) as string;
    expect(world.store.get(id)?.ssh.auth).toBe('agent');
    expect(Object.values(await world.store.getSshSecrets(id))[0]).toEqual({});
  });

  it.each([
    ['name', 0],
    ['host', 1],
    ['port', 2],
    ['user', 3],
    ['password', 4],
    ['start folder', 5],
  ])('saves nothing when the %s box is dismissed', async (_name, at) => {
    const all: (string | undefined)[] = ['N', 'h', '22', 'u', 'pw', ''];
    all[at] = undefined;
    answers(...all.slice(0, at + 1));
    window.showQuickPick.mockResolvedValue({ auth: 'password', value: false });
    const before = world.store.list().length;
    expect(await run('addServer')).toBeUndefined();
    expect(world.store.list()).toHaveLength(before);
  });

  it('saves nothing when the way to log in or the read-only choice is dismissed', async () => {
    answers('N', 'h', '22', 'u');
    window.showQuickPick.mockResolvedValueOnce(undefined);
    expect(await run('addServer')).toBeUndefined();
    answers('N', 'h', '22', 'u', 'pw', '');
    window.showQuickPick
      .mockResolvedValueOnce({ auth: 'password' })
      .mockResolvedValueOnce(undefined);
    expect(await run('addServer')).toBeUndefined();
    expect(world.store.list()).toHaveLength(2);
  });

  it('checks each answer as it is typed', async () => {
    answers('N', 'h', undefined);
    await run('addServer');
    interface Box {
      validateInput(value: string): string | undefined;
    }
    const [name, host, port] = window.showInputBox.mock.calls.map((call) => call[0] as Box);
    expect(name?.validateInput('  ')).toMatch(/cannot be empty/u);
    expect(name?.validateInput('Name')).toBeUndefined();
    expect(host?.validateInput('')).toMatch(/host/u);
    expect(host?.validateInput('example.com')).toBeUndefined();
    for (const bad of ['0', '70000', 'abc', '']) {
      expect(port?.validateInput(bad)).toMatch(/1 to 65535/u);
    }
    expect(port?.validateInput('2222')).toBeUndefined();
  });
});

describe('editing a server', () => {
  it('starts every box with the saved value and keeps an empty password', async () => {
    const before = world.store.get(world.serverId);
    answers('Web renamed', '127.0.0.1', String(world.server.port), 'deploy', '', '');
    window.showQuickPick
      .mockResolvedValueOnce({ auth: 'password' })
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ choice: 'direct' });
    expect(await run('editServer', server(world.serverId))).toBe(world.serverId);
    const boxes = window.showInputBox.mock.calls.map(
      (call) => (call[0] as { value?: string }).value,
    );
    expect(boxes[0]).toBe('Web');
    expect(boxes[1]).toBe('127.0.0.1');
    expect(boxes[3]).toBe('deploy');
    expect(world.store.get(world.serverId)?.name).toBe('Web renamed');
    expect(world.store.get(world.serverId)?.ssh.id).toBe(before?.ssh.id);
    expect(Object.values(await world.store.getSshSecrets(world.serverId))[0]).toEqual({
      password: 'pw',
    });
  });

  it('sets a new password, and drops the passphrase when the key is given up', async () => {
    answers('Web', '127.0.0.1', String(world.server.port), 'deploy', 'new-pw', '');
    window.showQuickPick
      .mockResolvedValueOnce({ auth: 'password' })
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ choice: 'direct' });
    await run('editServer', server(world.serverId));
    expect(Object.values(await world.store.getSshSecrets(world.serverId))[0]).toEqual({
      password: 'new-pw',
    });
  });

  it('closes the open session, so the next one uses the new settings', async () => {
    await world.hub.session(world.serverId);
    expect(world.hub.isOpen(world.serverId)).toBe(true);
    answers('Web', '127.0.0.1', String(world.server.port), 'deploy', '', '');
    window.showQuickPick
      .mockResolvedValueOnce({ auth: 'password' })
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ choice: 'direct' });
    await run('editServer', server(world.serverId));
    expect(world.hub.isOpen(world.serverId)).toBe(false);
  });

  it('asks which server when called from the palette', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    expect(await run('editServer')).toBeUndefined();
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('says so when there is no server to pick', async () => {
    await world.store.remove(world.serverId);
    await world.store.remove(world.readOnlyId);
    expect(await run('editServer')).toBeUndefined();
    expect(window.showInformationMessage).toHaveBeenCalledWith('There are no saved servers yet');
  });
});

describe('how a server is reached', () => {
  /** The picks of the wizard in order: login, read-only, then the way of reaching it. */
  function picks(...values: unknown[]): void {
    for (const value of values) {
      window.showQuickPick.mockResolvedValueOnce(value);
    }
  }

  const head = ['Via', 'target.example.com', '22', 'me', 'target-pw', ''];

  it('saves jump hosts, each with its own login and secret', async () => {
    answers(
      ...head,
      'jump1.example.com',
      '2201',
      'hopper',
      'hop-pw',
      'jump2.example.com',
      '22',
      'h2',
      '',
    );
    picks(
      { auth: 'password' },
      { value: false },
      { choice: 'jumps' },
      { auth: 'password' },
      { more: true },
      { auth: 'agent' },
      { more: false },
    );
    const id = (await run('addServer')) as string;
    const saved = world.store.get(id);
    expect(saved?.proxy).toBeUndefined();
    expect(saved?.ssh.jumps).toMatchObject([
      { host: 'jump1.example.com', port: 2201, user: 'hopper', auth: 'password' },
      { host: 'jump2.example.com', port: 22, user: 'h2', auth: 'agent' },
    ]);
    const secrets = await world.store.getSshSecrets(id);
    const jumpId = saved?.ssh.jumps?.[0]?.id ?? '';
    expect(secrets[jumpId]).toEqual({ password: 'hop-pw' });
    expect(secrets[saved?.ssh.id ?? '']).toEqual({ password: 'target-pw' });
  });

  it('stops asking for jump hosts at the limit', async () => {
    const hop = ['j.example.com', '22', 'u'];
    answers(...head, ...hop, ...hop, ...hop, ...hop, ...hop);
    picks(
      { auth: 'password' },
      { value: false },
      { choice: 'jumps' },
      ...Array.from({ length: 5 }, () => [{ auth: 'agent' }, { more: true }]).flat(),
    );
    const id = (await run('addServer')) as string;
    expect(world.store.get(id)?.ssh.jumps).toHaveLength(5);
  });

  it('saves a proxy with its login, the password going to the secrets', async () => {
    answers(...head, 'proxy.example.com', '3128', 'puser', 'ppass');
    picks({ auth: 'password' }, { value: false }, { choice: 'proxy' }, { proxyKind: 'http' });
    const id = (await run('addServer')) as string;
    expect(world.store.get(id)?.proxy).toEqual({
      kind: 'http',
      host: 'proxy.example.com',
      port: 3128,
      user: 'puser',
    });
    expect(world.store.get(id)?.ssh.jumps).toBeUndefined();
    expect(await world.store.getProxyPassword(id)).toBe('ppass');
  });

  it('takes a proxy without a login and asks for no password', async () => {
    answers(...head, 'p.example.com', '1080', '');
    picks({ auth: 'password' }, { value: false }, { choice: 'proxy' }, { proxyKind: 'socks5' });
    const id = (await run('addServer')) as string;
    expect(world.store.get(id)?.proxy).toEqual({
      kind: 'socks5',
      host: 'p.example.com',
      port: 1080,
    });
    expect(await world.store.getProxyPassword(id)).toBeUndefined();
  });

  it('takes jump hosts and a proxy together', async () => {
    answers(...head, 'j.example.com', '22', 'u', 'px.example.com', '1080', '');
    picks(
      { auth: 'password' },
      { value: false },
      { choice: 'both' },
      { auth: 'agent' },
      { more: false },
      { proxyKind: 'socks5' },
    );
    const id = (await run('addServer')) as string;
    expect(world.store.get(id)?.ssh.jumps).toHaveLength(1);
    expect(world.store.get(id)?.proxy?.host).toBe('px.example.com');
  });

  it.each([
    ['the way of reaching it', [], [undefined]],
    ['the host of a jump host', [undefined], ['jumps']],
    ['the way to log in to a jump host', ['j', '22', 'u'], ['jumps', undefined]],
    ['the proxy type', [], ['proxy', undefined]],
    ['the proxy host', [undefined], ['proxy', 'http']],
    ['the proxy port', ['p', undefined], ['proxy', 'http']],
    ['the proxy user', ['p', '8080', undefined], ['proxy', 'http']],
    ['the proxy password', ['p', '8080', 'u', undefined], ['proxy', 'http']],
  ])('saves nothing when %s is dismissed', async (_name, inputs, later) => {
    stub.resetWindow();
    const before = world.store.list().length;
    answers(...head, ...(inputs as (string | undefined)[]));
    const [choice, ...rest] = later as (string | undefined)[];
    picks({ auth: 'password' }, { value: false });
    picks(choice === undefined ? undefined : { choice });
    for (const value of rest) {
      picks(
        value === undefined
          ? undefined
          : value === 'http'
            ? { proxyKind: 'http' }
            : { auth: 'agent' },
      );
    }
    expect(await run('addServer')).toBeUndefined();
    expect(world.store.list()).toHaveLength(before);
  });

  it('checks the host, port and user of a jump host and of a proxy as they are typed', async () => {
    answers(...head, 'j', '22', 'u', '', 'p', undefined);
    picks(
      { auth: 'password' },
      { value: false },
      { choice: 'both' },
      { auth: 'agent' },
      { more: false },
      { proxyKind: 'http' },
    );
    await run('addServer');
    interface Box {
      title: string;
      validateInput?(value: string): string | undefined;
    }
    const boxes = window.showInputBox.mock.calls.map((call) => call[0] as Box);
    for (const title of ['Jump host 1: SSH host', 'Jump host 1: User', 'Proxy host']) {
      const box = boxes.find((item) => item.title === title);
      expect(box?.validateInput?.('  ')).toMatch(/cannot be empty/u);
      expect(box?.validateInput?.('x')).toBeUndefined();
    }
    for (const title of ['Jump host 1: SSH port', 'Proxy port']) {
      const box = boxes.find((item) => item.title === title);
      expect(box?.validateInput?.('0')).toMatch(/1 to 65535/u);
      expect(box?.validateInput?.('22')).toBeUndefined();
    }
    expect(boxes.find((item) => item.title === 'Proxy port')).toMatchObject({ value: '8080' });
  });

  it('keeps jump hosts and proxy as saved, with their secrets, when editing', async () => {
    const jumpHop = {
      id: 'jump',
      host: 'j.example.com',
      port: 22,
      user: 'u',
      auth: 'password' as const,
    };
    const added = await world.store.add(
      {
        name: 'Routed',
        ssh: {
          id: 'main',
          host: '127.0.0.1',
          port: world.server.port,
          user: 'deploy',
          auth: 'password',
          jumps: [jumpHop],
        },
        proxy: { kind: 'socks5', host: 'px', port: 1080, user: 'pu' },
      },
      { main: { password: 'pw' }, jump: { password: 'jpw' } },
      'proxy-pw',
    );
    answers('Routed', '127.0.0.1', String(world.server.port), 'deploy', '', '');
    picks({ auth: 'password' }, { value: false }, { choice: 'keep' });
    await run('editServer', server(added.id));
    const saved = world.store.get(added.id);
    expect(saved?.ssh.jumps).toEqual([jumpHop]);
    expect(saved?.proxy).toMatchObject({ host: 'px' });
    expect((await world.store.getSshSecrets(added.id)).jump).toEqual({ password: 'jpw' });
    expect(await world.store.getProxyPassword(added.id)).toBe('proxy-pw');
    const offered = window.showQuickPick.mock.calls.at(-1)?.[0] as {
      label: string;
      description?: string;
    }[];
    expect(offered.map((item) => item.description)).toContain('1 jump hosts · SOCKS5 px');
  });

  it('removes jump hosts and the proxy, with their secrets, when "Directly" is chosen', async () => {
    const added = await world.store.add(
      {
        name: 'Routed',
        ssh: {
          id: 'main',
          host: '127.0.0.1',
          port: world.server.port,
          user: 'deploy',
          auth: 'password',
          jumps: [{ id: 'jump', host: 'j', port: 22, user: 'u', auth: 'password' }],
        },
        proxy: { kind: 'http', host: 'px', user: 'pu' },
      },
      { main: { password: 'pw' }, jump: { password: 'jpw' } },
      'proxy-pw',
    );
    answers('Routed', '127.0.0.1', String(world.server.port), 'deploy', '', '');
    picks({ auth: 'password' }, { value: false }, { choice: 'direct' });
    await run('editServer', server(added.id));
    const saved = world.store.get(added.id);
    expect(saved?.ssh.jumps).toBeUndefined();
    expect(saved?.proxy).toBeUndefined();
    expect((await world.store.getSshSecrets(added.id)).jump).toBeUndefined();
    expect(await world.store.getProxyPassword(added.id)).toBeUndefined();
  });

  it('prefills the saved jump host and keeps its password when the box is left empty', async () => {
    const added = await world.store.add(
      {
        name: 'Routed',
        ssh: {
          id: 'main',
          host: '127.0.0.1',
          port: world.server.port,
          user: 'deploy',
          auth: 'password',
          jumps: [{ id: 'jump', host: 'j.example.com', port: 2200, user: 'u', auth: 'password' }],
        },
      },
      { main: { password: 'pw' }, jump: { password: 'jpw' } },
    );
    answers(
      'Routed',
      '127.0.0.1',
      String(world.server.port),
      'deploy',
      '',
      '',
      'j2.example.com',
      '2200',
      'u',
      '',
    );
    picks(
      { auth: 'password' },
      { value: false },
      { choice: 'jumps' },
      { auth: 'password' },
      { more: false },
    );
    await run('editServer', server(added.id));
    const boxes = window.showInputBox.mock.calls.map(
      (call) => call[0] as { title: string; value?: string },
    );
    expect(boxes.find((box) => box.title === 'Jump host 1: SSH host')?.value).toBe('j.example.com');
    expect(world.store.get(added.id)?.ssh.jumps?.[0]).toMatchObject({
      id: 'jump',
      host: 'j2.example.com',
    });
    expect((await world.store.getSshSecrets(added.id)).jump).toEqual({ password: 'jpw' });
  });
});

describe('deleting a server', () => {
  it('removes the saved login after a confirmation, and closes its session', async () => {
    await world.hub.session(world.serverId);
    window.showWarningMessage.mockResolvedValueOnce('Delete');
    await run('removeServer', server(world.serverId));
    expect(world.store.get(world.serverId)).toBeUndefined();
    expect(world.hub.isOpen(world.serverId)).toBe(false);
    expect(fs.has('/home/deploy/a.txt')).toBe(true);
  });

  it('keeps it when the confirmation is declined', async () => {
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('removeServer', server(world.serverId));
    expect(world.store.get(world.serverId)).toBeDefined();
  });
});

describe('small server commands', () => {
  it('switches read-only on and off', async () => {
    await run('toggleServerReadOnly', server(world.serverId));
    expect(world.store.get(world.serverId)?.readOnly).toBe(true);
    await run('toggleServerReadOnly', server(world.serverId));
    expect(world.store.get(world.serverId)?.readOnly).toBeUndefined();
  });

  it('disconnects a server, and ignores anything else', async () => {
    await world.hub.session(world.serverId);
    await run('disconnectServer', undefined);
    expect(world.hub.isOpen(world.serverId)).toBe(true);
    await run('disconnectServer', server(world.serverId));
    expect(world.hub.isOpen(world.serverId)).toBe(false);
  });

  it('refreshes the whole view or one node', async () => {
    const before = refreshes;
    await run('refreshServers');
    await run('refresh', server(world.serverId));
    await run('refresh', 'not a node');
    expect(refreshes).toBe(before + 3);
  });
});

describe('servers in a file', () => {
  it('exports without passwords, imports with a suffix for names already taken', async () => {
    const target = join(world.dir, 'servers.json');
    window.showSaveDialog.mockResolvedValueOnce(stub.Uri.file(target));
    await run('exportServers');
    const text = readFileSync(target, 'utf8');
    expect(text).not.toContain('"pw"');
    expect(text).toContain('Web (read-only)');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(target)]);
    await run('importServers');
    expect(world.store.list().map((item) => item.name)).toEqual([
      'Web',
      'Web (read-only)',
      'Web (2)',
      'Web (read-only) (2)',
    ]);
    const imported = world.store.list()[2];
    expect(await world.store.getSshSecrets(imported?.id ?? '')).toEqual({ main: {} });
  });

  it('says there is nothing to export, and does nothing when the dialogs are dismissed', async () => {
    window.showSaveDialog.mockResolvedValueOnce(undefined);
    await run('exportServers');
    window.showOpenDialog.mockResolvedValueOnce(undefined);
    await run('importServers');
    await world.store.remove(world.serverId);
    await world.store.remove(world.readOnlyId);
    await run('exportServers');
    expect(window.showInformationMessage).toHaveBeenCalledWith('There are no saved servers yet');
  });

  it('reports the entries it had to skip', async () => {
    const target = join(world.dir, 'mixed.json');
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        servers: [
          { name: 'Fine', ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' } },
          { name: 'Broken' },
        ],
      }),
    );
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(target)]);
    await run('importServers');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('1 servers added, 1 skipped.');
  });

  it('refuses a file that is not a servers file', async () => {
    const target = join(world.dir, 'bad.json');
    writeFileSync(target, '{"hello":1}');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(target)]);
    await expect(run('importServers')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('opening a file', () => {
  it('opens it in the editor by its address', async () => {
    await run('open', file('/home/deploy/a.txt'));
    expect(stub.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      expect.objectContaining({
        scheme: 'datanest-sftp',
        authority: world.serverId,
        path: '/home/deploy/a.txt',
      }),
    );
  });

  it('offers a download instead of a file larger than the limit', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Download');
    const node = file('/home/deploy/a.txt', world.serverId, 5000);
    await run('open', node);
    expect(stub.commands.executeCommand).toHaveBeenCalledWith('datanest.sftp.download', node);
    expect(stub.commands.executeCommand).not.toHaveBeenCalledWith('vscode.open', expect.anything());
  });

  it('leaves a too large file alone when the offer is declined', async () => {
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('open', file('/home/deploy/a.txt', world.serverId, 5000));
    expect(stub.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('asks before opening what is not text, and opens it only when told to', async () => {
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('open', file('/home/deploy/backup.zip'));
    expect(stub.commands.executeCommand).not.toHaveBeenCalled();
    window.showWarningMessage.mockResolvedValueOnce('Open Anyway');
    await run('open', file('/home/deploy/backup.zip'));
    expect(stub.commands.executeCommand).toHaveBeenCalledWith('vscode.open', expect.anything());
  });

  it('offers a download for what is not text', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Download');
    const node = file('/home/deploy/app.sqlite');
    await run('open', node);
    expect(stub.commands.executeCommand).toHaveBeenCalledWith('datanest.sftp.download', node);
  });

  it('ignores a folder', async () => {
    await run('open', folder('/home/deploy/dir'));
    expect(stub.commands.executeCommand).not.toHaveBeenCalled();
  });
});

describe('uploading', () => {
  it('uploads picked files into a folder, after asking about those that are there', async () => {
    writeFileSync(join(world.dir, 'new.txt'), 'new');
    writeFileSync(join(world.dir, 'a.txt'), 'replaced');
    window.showOpenDialog.mockResolvedValueOnce([
      stub.Uri.file(join(world.dir, 'new.txt')),
      stub.Uri.file(join(world.dir, 'a.txt')),
    ]);
    window.showWarningMessage.mockResolvedValueOnce('Replace');
    await run('upload', server(world.serverId));
    expect(fs.text('/home/deploy/new.txt')).toBe('new');
    expect(fs.text('/home/deploy/a.txt')).toBe('replaced');
    const asked = window.showWarningMessage.mock.calls[0];
    expect(asked?.[0]).toBe('"a.txt" already exists. Replace it?');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('Uploaded: 2 files, 11 B');
  });

  it('uploads nothing when the replacement is declined', async () => {
    writeFileSync(join(world.dir, 'a.txt'), 'replaced');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(join(world.dir, 'a.txt'))]);
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('upload', server(world.serverId));
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
    expect(window.withProgress).not.toHaveBeenCalled();
  });

  it('uploads into the folder it was called on, and a file node means the folder it lies in', async () => {
    writeFileSync(join(world.dir, 'x.txt'), 'x');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(join(world.dir, 'x.txt'))]);
    await run('upload', file('/home/deploy/dir/c.txt'));
    expect(fs.text('/home/deploy/dir/x.txt')).toBe('x');
  });

  it('uploads folders with everything in them', async () => {
    mkdirSync(join(world.dir, 'site', 'css'), { recursive: true });
    writeFileSync(join(world.dir, 'site', 'index.html'), '<html>');
    writeFileSync(join(world.dir, 'site', 'css', 'a.css'), 'a{}');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(join(world.dir, 'site'))]);
    await run('uploadFolder', folder('/dest'));
    expect(fs.text('/dest/site/css/a.css')).toBe('a{}');
    expect(fs.text('/dest/site/index.html')).toBe('<html>');
  });

  it('does nothing when nothing is picked', async () => {
    window.showOpenDialog.mockResolvedValueOnce(undefined);
    await run('upload', server(world.serverId));
    window.showOpenDialog.mockResolvedValueOnce([]);
    await run('uploadFolder', server(world.serverId));
    expect(window.withProgress).not.toHaveBeenCalled();
  });

  it('refuses on a read-only server before asking for anything', async () => {
    await expect(run('upload', server(world.readOnlyId))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(run('uploadFolder', server(world.readOnlyId))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(window.showOpenDialog).not.toHaveBeenCalled();
  });

  it('uploads files dropped on the tree, to the folder they were dropped on', async () => {
    writeFileSync(join(world.dir, 'dropped.txt'), 'd');
    await commands.drop(folder('/dest'), [join(world.dir, 'dropped.txt')]);
    expect(fs.text('/dest/dropped.txt')).toBe('d');
  });

  it('uploads files dropped on a server to its start folder', async () => {
    writeFileSync(join(world.dir, 'dropped.txt'), 'd');
    await commands.drop(server(world.serverId), [join(world.dir, 'dropped.txt')]);
    expect(fs.text('/home/deploy/dropped.txt')).toBe('d');
  });

  it('refuses a drop on a read-only server', async () => {
    writeFileSync(join(world.dir, 'dropped.txt'), 'd');
    await expect(
      commands.drop(server(world.readOnlyId), [join(world.dir, 'dropped.txt')]),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('does not guess where a drop on empty space should go when there are several servers', async () => {
    await commands.drop(undefined, ['/x']);
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      'Drop the files on a server or a folder in the Servers view.',
    );
  });

  it('sends a drop on empty space to the only server there is', async () => {
    await world.store.remove(world.readOnlyId);
    writeFileSync(join(world.dir, 'only.txt'), 'o');
    await commands.drop(undefined, [join(world.dir, 'only.txt')]);
    expect(fs.text('/home/deploy/only.txt')).toBe('o');
  });
});

describe('downloading', () => {
  it('downloads files and folders to the chosen folder', async () => {
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(world.dir)]);
    await run('download', file('/home/deploy/a.txt'), [file('/home/deploy/a.txt')]);
    expect(readFileSync(join(world.dir, 'a.txt'), 'utf8')).toBe('aaa');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(world.dir)]);
    await run('download', folder('/home/deploy/dir'));
    expect(readFileSync(join(world.dir, 'dir', 'c.txt'), 'utf8')).toBe('ccc');
  });

  it('downloads every selected item', async () => {
    const a = file('/home/deploy/a.txt');
    const b = file('/home/deploy/b.txt');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(world.dir)]);
    await run('download', a, [a, b]);
    expect(readFileSync(join(world.dir, 'b.txt'), 'utf8')).toBe('bbb');
  });

  it('asks before replacing a file of this machine, and keeps it when declined', async () => {
    writeFileSync(join(world.dir, 'a.txt'), 'mine');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(world.dir)]);
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('download', file('/home/deploy/a.txt'));
    expect(readFileSync(join(world.dir, 'a.txt'), 'utf8')).toBe('mine');
  });

  it('offers to show the result in the folder', async () => {
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(world.dir)]);
    window.showInformationMessage.mockResolvedValueOnce('Show in Folder');
    await run('download', file('/home/deploy/a.txt'));
    expect(stub.commands.executeCommand).toHaveBeenCalledWith(
      'revealFileInOS',
      expect.objectContaining({ path: join(world.dir, 'a.txt') }),
    );
  });

  it('does nothing without a folder, or without a node', async () => {
    window.showOpenDialog.mockResolvedValueOnce(undefined);
    await run('download', file('/home/deploy/a.txt'));
    await run('download', undefined);
    expect(window.withProgress).not.toHaveBeenCalled();
  });

  it('works on a read-only server: reading changes nothing', async () => {
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(world.dir)]);
    await run('download', file('/home/deploy/a.txt', world.readOnlyId));
    expect(readFileSync(join(world.dir, 'a.txt'), 'utf8')).toBe('aaa');
  });
});

describe('renaming', () => {
  it('renames, checking the name as it is typed', async () => {
    answers('renamed.txt');
    await run('rename', file('/home/deploy/a.txt'));
    expect(fs.text('/home/deploy/renamed.txt')).toBe('aaa');
    expect(fs.has('/home/deploy/a.txt')).toBe(false);
    const box = window.showInputBox.mock.calls[0]?.[0] as {
      value: string;
      valueSelection: [number, number];
      validateInput(value: string): string | undefined;
    };
    expect(box.value).toBe('a.txt');
    expect(box.valueSelection).toEqual([0, 1]);
    for (const bad of ['', '..', 'a/b']) {
      expect(box.validateInput(bad)).toMatch(/cannot be empty or contain/u);
    }
    expect(box.validateInput('fine')).toBeUndefined();
  });

  it('does nothing when the name is not changed or the box is dismissed', async () => {
    answers('a.txt');
    await run('rename', file('/home/deploy/a.txt'));
    answers(undefined);
    await run('rename', file('/home/deploy/a.txt'));
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
  });

  it('will not overwrite a file that is there', async () => {
    answers('b.txt');
    await expect(run('rename', file('/home/deploy/a.txt'))).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(fs.text('/home/deploy/b.txt')).toBe('bbb');
  });

  it('refuses on a read-only server, and without a node', async () => {
    await expect(run('rename', file('/home/deploy/a.txt', world.readOnlyId))).rejects.toMatchObject(
      {
        code: 'permission-denied',
      },
    );
    await expect(run('rename', undefined)).rejects.toMatchObject({ code: 'not-found' });
  });
});

/** The arguments of the n-th warning the command showed. */
function warning(index: number): [unknown, { detail: string }] {
  const call = window.showWarningMessage.mock.calls[index] as unknown as [
    unknown,
    { detail: string },
  ];
  return call;
}

describe('deleting', () => {
  it('deletes after a confirmation that names what goes', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Delete');
    await run('delete', file('/home/deploy/a.txt'));
    expect(fs.has('/home/deploy/a.txt')).toBe(false);
    const [text, options] = warning(0);
    expect(text).toBe('Delete "a.txt" from the server?');
    expect(options.detail).toContain('/home/deploy/a.txt');
    expect(options.detail).toContain('This cannot be undone.');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('Deleted: 1 items');
  });

  it('says that a folder goes with everything in it, and deletes every selected item', async () => {
    const dir = folder('/home/deploy/dir');
    const b = file('/home/deploy/b.txt');
    window.showWarningMessage.mockResolvedValueOnce('Delete');
    await run('delete', dir, [dir, b]);
    const [text, options] = warning(0);
    expect(text).toBe('Delete 2 items from the server?');
    expect(options.detail).toContain('with everything in them');
    expect(fs.has('/home/deploy/dir')).toBe(false);
    expect(fs.has('/home/deploy/b.txt')).toBe(false);
    expect(fs.has('/home/deploy/a.txt')).toBe(true);
  });

  it('deletes only the clicked item when it is not part of the selection', async () => {
    const a = file('/home/deploy/a.txt');
    const b = file('/home/deploy/b.txt');
    window.showWarningMessage.mockResolvedValueOnce('Delete');
    await run('delete', a, [b]);
    expect(fs.has('/home/deploy/a.txt')).toBe(false);
    expect(fs.has('/home/deploy/b.txt')).toBe(true);
  });

  it('keeps everything when the confirmation is declined', async () => {
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', file('/home/deploy/a.txt'));
    expect(fs.has('/home/deploy/a.txt')).toBe(true);
  });

  it('refuses on a read-only server before asking, and without a node', async () => {
    await expect(run('delete', file('/home/deploy/a.txt', world.readOnlyId))).rejects.toMatchObject(
      {
        code: 'permission-denied',
      },
    );
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(await run('delete', undefined)).toBeUndefined();
  });
});

describe('new folders and files', () => {
  it('makes a folder where it was called', async () => {
    answers('made');
    await run('newFolder', folder('/dest'));
    expect(fs.has('/dest/made')).toBe(true);
  });

  it('makes a folder in the start folder of a server', async () => {
    answers('made');
    await run('newFolder', server(world.serverId));
    expect(fs.has('/home/deploy/made')).toBe(true);
  });

  it('makes an empty file and opens it', async () => {
    answers('empty.txt');
    await run('newFile', folder('/dest'));
    expect(fs.text('/dest/empty.txt')).toBe('');
    expect(stub.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      expect.objectContaining({ path: '/dest/empty.txt' }),
    );
  });

  it('will not replace a file that is there', async () => {
    answers('a.txt');
    await expect(run('newFile', server(world.serverId))).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
  });

  it('does nothing when the box is dismissed, and refuses on a read-only server', async () => {
    answers(undefined, undefined);
    await run('newFolder', folder('/dest'));
    await run('newFile', folder('/dest'));
    expect(fs.names('/dest')).toEqual([]);
    await expect(run('newFolder', server(world.readOnlyId))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(run('newFile', server(world.readOnlyId))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(await run('newFolder', undefined)).toBeUndefined();
    expect(await run('newFile', undefined)).toBeUndefined();
  });
});

describe('permissions', () => {
  it('changes them from octal digits, starting with the current ones', async () => {
    answers('600');
    await run('chmod', file('/home/deploy/a.txt'));
    expect(fs.modeOf('/home/deploy/a.txt')).toBe(0o600);
    const box = window.showInputBox.mock.calls[0]?.[0] as {
      value: string;
      validateInput(value: string): string | undefined;
    };
    expect(box.value).toBe('644');
    expect(box.validateInput('999')).toMatch(/octal digits/u);
    expect(box.validateInput('755')).toBeUndefined();
  });

  it('does nothing when dismissed, and refuses on a read-only server', async () => {
    answers(undefined);
    await run('chmod', file('/home/deploy/a.txt'));
    expect(fs.modeOf('/home/deploy/a.txt')).toBe(0o644);
    await expect(run('chmod', file('/home/deploy/a.txt', world.readOnlyId))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('copying a path', () => {
  it('puts the path (or the paths, one to a line) on the clipboard', async () => {
    const a = file('/home/deploy/a.txt');
    const b = file('/home/deploy/b.txt');
    await run('copyPath', a);
    expect(stub.env.clipboard.writeText).toHaveBeenLastCalledWith('/home/deploy/a.txt');
    await run('copyPath', a, [a, b]);
    expect(stub.env.clipboard.writeText).toHaveBeenLastCalledWith(
      '/home/deploy/a.txt\n/home/deploy/b.txt',
    );
    await run('copyPath', undefined);
    expect(stub.env.clipboard.writeText).toHaveBeenCalledTimes(2);
  });
});

describe('copying and moving', () => {
  it('copies within a server to the path typed', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: world.serverId });
    answers('/dest/copy-of-a.txt');
    await run('copyTo', file('/home/deploy/a.txt'));
    expect(fs.text('/dest/copy-of-a.txt')).toBe('aaa');
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('Copied: 1 files, 3 B');
  });

  it('copies a folder with everything in it', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: world.serverId });
    answers('/dest/dir');
    await run('copyTo', folder('/home/deploy/dir'));
    expect(fs.text('/dest/dir/c.txt')).toBe('ccc');
  });

  it('will not copy over something that is there', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: world.serverId });
    answers('/home/deploy/b.txt');
    await expect(run('copyTo', file('/home/deploy/a.txt'))).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(fs.text('/home/deploy/b.txt')).toBe('bbb');
  });

  it('copies to another server', async () => {
    const twin = await world.store.add(
      {
        name: 'Twin',
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
    window.showQuickPick.mockResolvedValueOnce({ id: twin.id });
    answers('/dest/across.txt');
    await run('copyTo', file('/home/deploy/a.txt'));
    expect(fs.text('/dest/across.txt')).toBe('aaa');
    const box = window.showInputBox.mock.calls[0]?.[0] as { title: string };
    expect(box.title).toContain('Twin');
  });

  it('will not copy into a read-only server, but copies out of one', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: world.readOnlyId });
    answers('/dest/x.txt');
    await expect(run('copyTo', file('/home/deploy/a.txt'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(fs.has('/dest/x.txt')).toBe(false);
    window.showQuickPick.mockResolvedValueOnce({ id: world.serverId });
    answers('/dest/from-ro.txt');
    await run('copyTo', file('/home/deploy/a.txt', world.readOnlyId));
    expect(fs.text('/dest/from-ro.txt')).toBe('aaa');
  });

  it('does nothing when a dialog is dismissed', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await run('copyTo', file('/home/deploy/a.txt'));
    window.showQuickPick.mockResolvedValueOnce({ id: world.serverId });
    answers(undefined);
    await run('copyTo', file('/home/deploy/a.txt'));
    expect(fs.names('/dest')).toEqual([]);
  });

  it('asks for an absolute path', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: world.serverId });
    answers(undefined);
    await run('copyTo', file('/home/deploy/a.txt'));
    const box = window.showInputBox.mock.calls[0]?.[0] as {
      value: string;
      validateInput(value: string): string | undefined;
    };
    expect(box.value).toBe('/home/deploy/a.txt');
    expect(box.validateInput('relative/path')).toMatch(/absolute path/u);
    expect(box.validateInput('  ')).toMatch(/absolute path/u);
    expect(box.validateInput('/ok')).toBeUndefined();
  });

  it('moves within the server to the path typed, with no question about deleting', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: world.serverId });
    answers('/dest/moved.txt');
    await run('moveTo', file('/home/deploy/a.txt'));
    expect(fs.text('/dest/moved.txt')).toBe('aaa');
    expect(fs.has('/home/deploy/a.txt')).toBe(false);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('will not move onto something that is there, into itself, or on a read-only server', async () => {
    window.showQuickPick.mockResolvedValue({ id: world.serverId });
    answers('/home/deploy/b.txt');
    await expect(run('moveTo', file('/home/deploy/a.txt'))).rejects.toMatchObject({
      code: 'unsupported',
    });
    answers('/home/deploy/dir/inside');
    await expect(run('moveTo', folder('/home/deploy/dir'))).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(run('moveTo', file('/home/deploy/a.txt', world.readOnlyId))).rejects.toMatchObject(
      {
        code: 'permission-denied',
      },
    );
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
  });

  it('moves to another server: asks first, copies, then deletes the original', async () => {
    const twin = await addTwin();
    window.showQuickPick.mockResolvedValueOnce({ id: twin });
    window.showWarningMessage.mockResolvedValueOnce('Move');
    answers('/dest/across.txt');
    await run('moveTo', file('/home/deploy/a.txt'));
    expect(fs.text('/dest/across.txt')).toBe('aaa');
    expect(fs.has('/home/deploy/a.txt')).toBe(false);
    const [question, options] = (window.showWarningMessage.mock.calls[0] ?? []) as unknown[];
    expect(question).toBe('Move "a.txt" to the server "Twin"?');
    expect((options as { detail: string }).detail).toMatch(/originals are deleted/u);
  });

  it('leaves everything as it was when the move to another server is not confirmed', async () => {
    const twin = await addTwin();
    window.showQuickPick.mockResolvedValueOnce({ id: twin });
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    answers('/dest/across.txt');
    await run('moveTo', file('/home/deploy/a.txt'));
    expect(fs.has('/dest/across.txt')).toBe(false);
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
  });

  it('will not move into a read-only server', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: world.readOnlyId });
    answers('/dest/x.txt');
    await expect(run('moveTo', file('/home/deploy/a.txt'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
  });

  it('keeps the original and says so when the copy left links out', async () => {
    const twin = await addTwin();
    fs.folder('/home/deploy/linked/real').link(
      '/home/deploy/linked/ln',
      '/home/deploy/linked/real',
    );
    window.showQuickPick.mockResolvedValueOnce({ id: twin });
    window.showWarningMessage.mockResolvedValueOnce('Move');
    answers('/dest/linked');
    await run('moveTo', folder('/home/deploy/linked'));
    expect(fs.has('/dest/linked/real')).toBe(true);
    expect(fs.has('/home/deploy/linked/real')).toBe(true);
    expect(window.showWarningMessage).toHaveBeenLastCalledWith(
      'Copied, but 1 originals were kept: they hold links or special files that were not copied.',
    );
  });
});

describe('dragging inside the tree', () => {
  const entries = (...nodes: ServerNode[]): never => nodes as never;

  it('moves files and folders into the folder they were dropped on', async () => {
    await commands.moveEntries(
      folder('/dest'),
      entries(file('/home/deploy/a.txt'), folder('/home/deploy/dir')),
    );
    expect(fs.text('/dest/a.txt')).toBe('aaa');
    expect(fs.text('/dest/dir/c.txt')).toBe('ccc');
    expect(fs.has('/home/deploy/a.txt')).toBe(false);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(refreshes).toBeGreaterThan(0);
  });

  it('takes a drop on a file as a drop on its folder, and on a server as its start folder', async () => {
    await commands.moveEntries(file('/dest/other.txt'), entries(file('/home/deploy/a.txt')));
    expect(fs.has('/dest/a.txt')).toBe(true);
    fs.folder('/home/deploy');
    await commands.moveEntries(server(world.serverId), entries(file('/dest/a.txt')));
    expect(fs.has('/home/deploy/a.txt')).toBe(true);
  });

  it('does nothing for a drop where the item already is, on itself, or on empty space', async () => {
    await commands.moveEntries(folder('/home/deploy'), entries(file('/home/deploy/a.txt')));
    await commands.moveEntries(folder('/home/deploy/dir'), entries(folder('/home/deploy/dir')));
    await commands.moveEntries(undefined, entries(file('/home/deploy/a.txt')));
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('will not drop a folder into itself, and refuses on a read-only server', async () => {
    await expect(
      commands.moveEntries(
        folder('/home/deploy/dir/c.txt'.replace('/c.txt', '')),
        entries(folder('/home/deploy')),
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      commands.moveEntries(folder('/dest', world.readOnlyId), entries(file('/home/deploy/a.txt'))),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      commands.moveEntries(folder('/dest'), entries(file('/home/deploy/a.txt', world.readOnlyId))),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
  });

  it('will not overwrite what is already in the folder', async () => {
    fs.file('/dest/a.txt', 'old');
    await expect(
      commands.moveEntries(folder('/dest'), entries(file('/home/deploy/a.txt'))),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(fs.text('/dest/a.txt')).toBe('old');
    expect(fs.text('/home/deploy/a.txt')).toBe('aaa');
  });

  it('asks before moving between servers, and does nothing when refused', async () => {
    const twin = await addTwin();
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await commands.moveEntries(
      folder('/dest', twin),
      entries(file('/home/deploy/a.txt'), file('/home/deploy/b.txt')),
    );
    expect(window.showWarningMessage.mock.calls[0]?.[0]).toBe('Move 2 items to the server "Twin"?');
    expect(fs.has('/dest/a.txt')).toBe(false);
    window.showWarningMessage.mockResolvedValueOnce('Move');
    await commands.moveEntries(
      folder('/dest', twin),
      entries(file('/home/deploy/a.txt'), file('/home/deploy/b.txt')),
    );
    expect(fs.text('/dest/a.txt')).toBe('aaa');
    expect(fs.text('/dest/b.txt')).toBe('bbb');
    expect(fs.has('/home/deploy/b.txt')).toBe(false);
  });
});

describe('permissions and owner of everything inside', () => {
  beforeEach(() => {
    fs.file('/home/deploy/tree/top.txt', 't', 0o600)
      .file('/home/deploy/tree/sub/in.txt', 'i', 0o600)
      .folder('/home/deploy/tree/sub/deep', 0o700);
  });

  it('gives files and folders their own modes after a confirmation', async () => {
    answers('640', '750');
    window.showWarningMessage.mockResolvedValueOnce('Change');
    await run('chmodTree', folder('/home/deploy/tree'));
    expect(fs.modeOf('/home/deploy/tree/top.txt')).toBe(0o640);
    expect(fs.modeOf('/home/deploy/tree/sub/in.txt')).toBe(0o640);
    expect(fs.modeOf('/home/deploy/tree/sub')).toBe(0o750);
    expect(fs.modeOf('/home/deploy/tree/sub/deep')).toBe(0o750);
    expect(fs.modeOf('/home/deploy/tree')).toBe(0o750);
    const detail = (window.showWarningMessage.mock.calls[0]?.[1] as { detail: string }).detail;
    expect(detail).toContain('Files: 640');
    expect(detail).toContain('Folders: 750');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith(
      'Permissions changed: 5 items, 0 links skipped',
    );
  });

  it('keeps what is left empty, and checks the digits', async () => {
    answers('', '700');
    window.showWarningMessage.mockResolvedValueOnce('Change');
    await run('chmodTree', folder('/home/deploy/tree'));
    expect(fs.modeOf('/home/deploy/tree/top.txt')).toBe(0o600);
    expect(fs.modeOf('/home/deploy/tree/sub')).toBe(0o700);
    const box = window.showInputBox.mock.calls[0]?.[0] as {
      value: string;
      validateInput(value: string): string | undefined;
    };
    expect(box.value).toBe('644');
    expect(box.validateInput('')).toBeUndefined();
    expect(box.validateInput('999')).toMatch(/octal digits/u);
  });

  it('does nothing when both are empty, a question is dismissed, or it is not confirmed', async () => {
    answers('', '');
    await run('chmodTree', folder('/home/deploy/tree'));
    answers(undefined);
    await run('chmodTree', folder('/home/deploy/tree'));
    answers('644', undefined);
    await run('chmodTree', folder('/home/deploy/tree'));
    answers('644', '755');
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('chmodTree', folder('/home/deploy/tree'));
    await run('chmodTree', file('/home/deploy/a.txt'));
    expect(fs.modeOf('/home/deploy/tree/top.txt')).toBe(0o600);
    expect(fs.modeOf('/home/deploy/tree')).toBe(0o755);
  });

  it('refuses on a read-only server', async () => {
    await expect(
      run('chmodTree', folder('/home/deploy/tree', world.readOnlyId)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('changes the owner of a file, starting with the current one', async () => {
    const node = file('/home/deploy/a.txt');
    if (node.kind === 'entry') {
      Object.assign(node.entry, { uid: 1000, gid: 1000 });
    }
    answers('33:44');
    await run('chown', node);
    expect(fs.ownerOf('/home/deploy/a.txt')).toEqual({ uid: 33, gid: 44 });
    const box = window.showInputBox.mock.calls[0]?.[0] as {
      value: string;
      validateInput(value: string): string | undefined;
    };
    expect(box.value).toBe('1000:1000');
    expect(box.validateInput('root')).toMatch(/numbers/u);
    expect(box.validateInput(':5')).toBeUndefined();
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('changes the owner of a folder only, or of everything inside it', async () => {
    answers('7:8');
    window.showQuickPick.mockResolvedValueOnce({ recursive: false });
    await run('chown', folder('/home/deploy/tree'));
    expect(fs.ownerOf('/home/deploy/tree')).toEqual({ uid: 7, gid: 8 });
    expect(fs.ownerOf('/home/deploy/tree/top.txt')).toEqual({ uid: 1000, gid: 1000 });
    answers(':9');
    window.showQuickPick.mockResolvedValueOnce({ recursive: true });
    await run('chown', folder('/home/deploy/tree'));
    expect(fs.ownerOf('/home/deploy/tree/sub/in.txt')).toEqual({ uid: 1000, gid: 9 });
    expect(fs.ownerOf('/home/deploy/tree')).toEqual({ uid: 7, gid: 9 });
    expect(window.showInformationMessage).toHaveBeenLastCalledWith(
      'Owner changed: 5 items, 0 links skipped',
    );
  });

  it('does nothing when dismissed, and refuses on a read-only server', async () => {
    answers(undefined);
    await run('chown', file('/home/deploy/a.txt'));
    answers('5:5');
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await run('chown', folder('/home/deploy/tree'));
    expect(fs.ownerOf('/home/deploy/a.txt')).toEqual({ uid: 1000, gid: 1000 });
    expect(fs.ownerOf('/home/deploy/tree')).toEqual({ uid: 1000, gid: 1000 });
    await expect(run('chown', file('/home/deploy/a.txt', world.readOnlyId))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('says when the server does not allow it', async () => {
    fs.deny('/home/deploy/a.txt');
    answers('5:5');
    await expect(run('chown', file('/home/deploy/a.txt'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('comparing with a local file', () => {
  it('opens a diff of the local file against the one on the server', async () => {
    const mine = join(tmpdir(), `datanest-compare-mine-${process.pid}.txt`);
    writeFileSync(mine, 'mine');
    window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(mine)]);
    try {
      await run('compareWithLocal', file('/home/deploy/a.txt'));
    } finally {
      rmSync(mine, { force: true });
    }
    const [command, left, right, title] = (stub.commands.executeCommand.mock.calls.at(-1) ??
      []) as unknown[];
    expect(command).toBe('vscode.diff');
    expect((left as { fsPath: string }).fsPath).toBe(mine);
    expect((right as { scheme: string }).scheme).toBe('datanest-sftp');
    expect(title).toBe(`${basename(mine)} ↔ a.txt on the server`);
  });

  it('does nothing when no file is chosen, or for a folder', async () => {
    window.showOpenDialog.mockResolvedValueOnce(undefined);
    await run('compareWithLocal', file('/home/deploy/a.txt'));
    await run('compareWithLocal', folder('/home/deploy/dir'));
    expect(stub.commands.executeCommand).not.toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses a file that is too large or not text, on either side', async () => {
    await expect(
      run('compareWithLocal', file('/home/deploy/a.txt', world.serverId, 5000)),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(run('compareWithLocal', file('/home/deploy/pack.zip'))).rejects.toMatchObject({
      code: 'unsupported',
    });
    const big = join(tmpdir(), `datanest-compare-${process.pid}.txt`);
    writeFileSync(big, 'x'.repeat(2000));
    try {
      window.showOpenDialog.mockResolvedValueOnce([stub.Uri.file(big)]);
      await expect(run('compareWithLocal', file('/home/deploy/a.txt'))).rejects.toMatchObject({
        code: 'unsupported',
      });
    } finally {
      rmSync(big, { force: true });
    }
  });
});

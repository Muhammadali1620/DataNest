// The commands of the Servers view (V13.16): what they ask, what they refuse, what they do
// on the server — with the editor's dialogs answered by the test and a real SFTP session.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
      .mockResolvedValueOnce({ value: true });
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
      .mockResolvedValueOnce({ value: false });
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
      .mockResolvedValueOnce({ value: false });
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
      .mockResolvedValueOnce({ value: false });
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
      .mockResolvedValueOnce({ value: false });
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
      .mockResolvedValueOnce({ value: false });
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

  it('moves within the server, without asking which one', async () => {
    answers('/dest/moved.txt');
    await run('moveTo', file('/home/deploy/a.txt'));
    expect(fs.text('/dest/moved.txt')).toBe('aaa');
    expect(fs.has('/home/deploy/a.txt')).toBe(false);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('will not move onto something that is there, into itself, or on a read-only server', async () => {
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
});

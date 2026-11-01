// The Servers view in a real editor (V13.16): its commands, its view, and the file system
// that opens a server's files. The logins themselves are tested against an SSH server inside
// the unit tests; here only what needs the real editor is checked.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

describe('servers view', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  it('registers every command of the view', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'datanest.servers.add',
      'datanest.servers.edit',
      'datanest.servers.remove',
      'datanest.servers.disconnect',
      'datanest.servers.toggleReadOnly',
      'datanest.servers.refresh',
      'datanest.servers.export',
      'datanest.servers.import',
      'datanest.sftp.open',
      'datanest.sftp.upload',
      'datanest.sftp.uploadFolder',
      'datanest.sftp.download',
      'datanest.sftp.rename',
      'datanest.sftp.delete',
      'datanest.sftp.newFolder',
      'datanest.sftp.newFile',
      'datanest.sftp.chmod',
      'datanest.sftp.copyPath',
      'datanest.sftp.copyTo',
      'datanest.sftp.moveTo',
      'datanest.sftp.refresh',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  it('can be focused', async () => {
    await vscode.commands.executeCommand('datanest.servers.focus');
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('datanest.servers.focus'), 'the view command is missing');
  });

  it('has the settings of the view with their defaults', () => {
    const settings = vscode.workspace.getConfiguration('datanest');
    assert.equal(settings.get('servers.maxOpenSizeMb'), 5);
    assert.equal(settings.get('servers.showHidden'), true);
  });

  it('serves the datanest-sftp scheme: a server that is not saved is "not found"', async () => {
    const uri = vscode.Uri.from({
      scheme: 'datanest-sftp',
      authority: 'no-such-server',
      path: '/',
    });
    await assert.rejects(
      async () => await vscode.workspace.fs.stat(uri),
      (error: unknown) => error instanceof vscode.FileSystemError,
    );
  });

  it("reading a file of a server that is not saved fails with the editor's own error", async () => {
    const uri = vscode.Uri.from({
      scheme: 'datanest-sftp',
      authority: 'no-such-server',
      path: '/etc/hosts',
    });
    await assert.rejects(
      async () => await vscode.workspace.fs.readFile(uri),
      (error: unknown) => error instanceof vscode.FileSystemError,
    );
  });
});

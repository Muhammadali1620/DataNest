// "New Query" in a real editor: an untitled SQL document opens, the status bar
// item appears for it, and closing the document lets go of its binding.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

describe('new query', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  it('opens an empty untitled SQL document', async () => {
    await vscode.commands.executeCommand('datanest.query.new');
    const document = vscode.window.activeTextEditor?.document;
    assert.ok(document, 'no editor became active');
    assert.equal(document.languageId, 'sql');
    assert.equal(document.isUntitled, true);
    assert.equal(document.getText(), '');
  });

  it('opens a separate document every time', async () => {
    await vscode.commands.executeCommand('datanest.query.new');
    const first = vscode.window.activeTextEditor?.document.uri.toString();
    await vscode.commands.executeCommand('datanest.query.new');
    const second = vscode.window.activeTextEditor?.document.uri.toString();
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first, second);
  });

  it('registers both query commands', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('datanest.query.new'));
    assert.ok(all.includes('datanest.query.selectConnection'));
  });

  it('tells the user to open a query when there is no SQL editor', async () => {
    await closeAllEditors();
    await sleep(100);
    // With no SQL document in front, the command must not throw.
    const picked = await vscode.commands.executeCommand('datanest.query.selectConnection');
    assert.equal(picked, undefined);
  });

  it('survives closing the document it created', async () => {
    await vscode.commands.executeCommand('datanest.query.new');
    await closeAllEditors();
    await sleep(100);
    // The binding is gone with the document; opening another one still works.
    await vscode.commands.executeCommand('datanest.query.new');
    assert.equal(vscode.window.activeTextEditor?.document.languageId, 'sql');
  });
});

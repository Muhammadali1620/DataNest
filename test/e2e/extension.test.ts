import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

describe('DataNest extension', () => {
  it('is installed in the test host', () => {
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID));
  });

  it('is not activated on startup', () => {
    // Activation must be lazy (ARCHITECTURE.md §7).
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, false);
  });

  it('activates without errors', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  it('opens its activity bar container and the connections view', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('workbench.view.extension.datanest'));
    assert.ok(commands.includes('datanest.connections.focus'));
    await vscode.commands.executeCommand('workbench.view.extension.datanest');
    await vscode.commands.executeCommand('datanest.connections.focus');
  });
});

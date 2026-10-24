import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

interface Manifest {
  contributes: { commands: { command: string }[] };
}

function extension(): vscode.Extension<unknown> {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(found, `${EXTENSION_ID} is not installed in the test host`);
  return found;
}

describe('DataNest extension', () => {
  it('is installed in the test host', () => {
    extension();
  });

  it('is not activated on startup', () => {
    // Activation must be lazy (ARCHITECTURE.md §7).
    assert.equal(extension().isActive, false);
  });

  it('activates without errors', async () => {
    await extension().activate();
    assert.equal(extension().isActive, true);
  });

  it('registers every command from package.json', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const { contributes } = extension().packageJSON as Manifest;
    const missing = contributes.commands.map((c) => c.command).filter((id) => !registered.has(id));
    assert.deepEqual(missing, []);
  });

  it('opens its activity bar container and the connections view', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.datanest');
    await vscode.commands.executeCommand('datanest.connections.focus');
  });

  it('shows the logs', async () => {
    await vscode.commands.executeCommand('datanest.logs.show');
  });

  it('follows log level changes at runtime', async () => {
    const config = vscode.workspace.getConfiguration('datanest');
    assert.equal(config.get('logLevel'), 'info');
    await config.update('logLevel', 'debug', vscode.ConfigurationTarget.Global);
    try {
      assert.equal(vscode.workspace.getConfiguration('datanest').get('logLevel'), 'debug');
      await vscode.commands.executeCommand('datanest.logs.show');
    } finally {
      await config.update('logLevel', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

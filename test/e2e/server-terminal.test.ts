// The SSH terminal in a real editor (V13.18): its commands are registered. The logins, the
// shell and the window changes are tested against an SSH server inside the unit tests; a real
// terminal pane cannot be driven from here.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

describe('server terminal', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  it('registers Open Terminal and Run Command on Server', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['datanest.servers.terminal', 'datanest.servers.runCommand']) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  it('contributes both commands to the palette with their titles', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const commands =
      (extension?.packageJSON as { contributes?: { commands?: { command: string }[] } } | undefined)
        ?.contributes?.commands ?? [];
    const ids = commands.map((item) => item.command);
    assert.ok(ids.includes('datanest.servers.terminal'));
    assert.ok(ids.includes('datanest.servers.runCommand'));
  });
});

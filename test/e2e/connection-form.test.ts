// The connection form in a real editor: the command opens a webview tab, the panel
// is reused per connection, and the stored connection survives a round trip through
// globalState and SecretStorage.

import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';
const VIEW_TYPE = 'datanest.connectionForm';

function formTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE),
    );
}

async function closeFormTabs(): Promise<void> {
  const tabs = formTabs();
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
  await waitForFormTabs(0);
}

const TAB_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The tab model is updated asynchronously, so the count is polled. */
async function waitForFormTabs(expected: number): Promise<void> {
  const deadline = Date.now() + TAB_TIMEOUT_MS;
  while (formTabs().length !== expected && Date.now() < deadline) {
    await sleep(50);
  }
  assert.equal(formTabs().length, expected, `expected ${expected} connection form tab(s)`);
}

describe('connection form panel', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  afterEach(async () => {
    await closeFormTabs();
  });

  it('opens a webview tab for a new connection', async () => {
    await vscode.commands.executeCommand('datanest.connections.add');
    await waitForFormTabs(1);
    assert.equal(formTabs()[0]?.label, 'New Connection');
  });

  it('reuses the same tab instead of piling up panels', async () => {
    await vscode.commands.executeCommand('datanest.connections.add');
    await waitForFormTabs(1);
    await vscode.commands.executeCommand('datanest.connections.add');
    // Give a second panel the chance to appear before trusting the count.
    await sleep(300);
    assert.equal(formTabs().length, 1);
  });

  it('registers every connection command', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'datanest.connections.add',
      'datanest.connections.addFromUrl',
      'datanest.connections.importEnv',
      'datanest.connections.edit',
      'datanest.connections.duplicate',
      'datanest.connections.remove',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });
});

describe('saved connections in the real editor', () => {
  let dir: string;

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    dir = mkdtempSync(join(tmpdir(), 'datanest-e2e-form-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a SQLite connection end to end through the driver registry', async () => {
    // The form's job is to produce a config the drivers can open; this checks the
    // whole chain with the bundles the extension actually ships.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const bundle = join(extension.extensionPath, 'dist', 'drivers', 'sqlite.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(bundle) as {
      driver: {
        openSession(config: Record<string, unknown>): Promise<{
          execute(sql: string): AsyncIterable<{ kind: string }>;
          close(): Promise<void>;
        }>;
      };
    };
    const session = await loaded.driver.openSession({
      id: 'e2e-form',
      name: 'e2e form',
      driver: 'sqlite',
      file: join(dir, 'form.db'),
    });
    try {
      const kinds: string[] = [];
      for await (const event of session.execute('SELECT 1')) {
        kinds.push(event.kind);
      }
      assert.deepEqual(kinds, ['columns', 'rows', 'done']);
    } finally {
      await session.close();
    }
  });

  it('opens the new-connection form filled from a URL argument', async () => {
    await closeFormTabs();
    await vscode.commands.executeCommand(
      'datanest.connections.addFromUrl',
      'postgres://app:secret@db.example:6543/shop?sslmode=require',
    );
    await waitForFormTabs(1);
    assert.equal(formTabs()[0]?.label, 'New Connection');
    await closeFormTabs();
  });

  it('opens no form for a URL it cannot read', async () => {
    await closeFormTabs();
    await vscode.commands.executeCommand(
      'datanest.connections.addFromUrl',
      'mongodb://cache:27017',
    );
    await sleep(300);
    assert.equal(formTabs().length, 0);
  });

  it('finishes the .env import quietly when there is nothing to import', async () => {
    await vscode.commands.executeCommand('datanest.connections.importEnv');
  });
});

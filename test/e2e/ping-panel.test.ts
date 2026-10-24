import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { PingPanelHandle } from '../../src/vscode/panels/ping-panel';

// Proves in a real VS Code that a webview bundle loads under our CSP and nonce,
// assets resolve through asWebviewUri, and RPC works in both directions.

const READY_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${what} did not happen within ${ms} ms`));
      }, ms);
    }),
  ]);
}

async function openPing(): Promise<PingPanelHandle> {
  const handle = await vscode.commands.executeCommand<PingPanelHandle | undefined>(
    'datanest.dev.openPing',
  );
  assert.ok(handle, 'openPing returned no panel');
  return handle;
}

function pingTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('datanest.ping'),
    );
}

describe('ping panel', () => {
  before(async () => {
    // Before activation, VS Code runs the command in another process and the handle
    // comes back serialized, without methods. Real callers never need the handle.
    await vscode.extensions.getExtension('datanest.datanest')?.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('opens a webview tab', async () => {
    const panel = await openPing();
    try {
      // The tab model is updated asynchronously; by "ready" it is up to date.
      await withTimeout(panel.ready, READY_TIMEOUT_MS, 'The ready event');
      assert.equal(pingTabs().length, 1);
      assert.equal(pingTabs()[0]?.label, 'DataNest Ping');
    } finally {
      panel.dispose();
    }
  });

  it('runs the page script, which reports ready to the host', async () => {
    const panel = await openPing();
    try {
      await withTimeout(panel.ready, READY_TIMEOUT_MS, 'The ready event');
    } finally {
      panel.dispose();
    }
  });

  it('answers requests from the host (host → webview → host)', async () => {
    const panel = await openPing();
    try {
      await withTimeout(panel.ready, READY_TIMEOUT_MS, 'The ready event');
      assert.equal(await panel.echo('round trip 🚀'), 'round trip 🚀');
      assert.equal(await panel.echo('Ольга'), 'Ольга');
    } finally {
      panel.dispose();
    }
  });

  it('cleans up when the user closes the tab', async () => {
    const panel = await openPing();
    await withTimeout(panel.ready, READY_TIMEOUT_MS, 'The ready event');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.equal(pingTabs().length, 0);
    assert.equal(panel.isDisposed, true);
    await assert.rejects(panel.echo('x'), { code: 'disposed' });
  });

  it('keeps several pages independent', async () => {
    const first = await openPing();
    const second = await openPing();
    try {
      // The second tab hides the first; a hidden webview is unloaded until shown again.
      await withTimeout(second.ready, READY_TIMEOUT_MS, 'The second ready event');
      first.dispose();
      assert.equal(await second.echo('still alive'), 'still alive');
      assert.equal(pingTabs().length, 1);
    } finally {
      second.dispose();
    }
  });

  it('loads a page that was hidden when its tab is shown again', async () => {
    const first = await openPing();
    const second = await openPing();
    try {
      await withTimeout(second.ready, READY_TIMEOUT_MS, 'The second ready event');
      const firstTab = pingTabs().find((tab) => !tab.isActive);
      assert.ok(firstTab);
      await vscode.commands.executeCommand('workbench.action.previousEditor');
      await withTimeout(first.ready, READY_TIMEOUT_MS, 'The first ready event after showing');
      assert.equal(await first.echo('back'), 'back');
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

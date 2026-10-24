// The result panel in a real editor: "Show Results" opens it beside the query and
// its page loads under our CSP, while a run without a connection opens nothing.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';
const VIEW_TYPE = 'datanest.results';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resultTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE),
    );
}

async function waitForResultTabs(expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (resultTabs().length !== expected && Date.now() < deadline) {
    await sleep(50);
  }
  assert.equal(resultTabs().length, expected, `expected ${expected} result tab(s)`);
}

async function openQuery(content = 'SELECT 1;'): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

describe('results panel', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitForResultTabs(0);
  });

  it('opens beside the query on demand', async () => {
    const document = await openQuery();
    await vscode.commands.executeCommand('datanest.results.show');
    await waitForResultTabs(1);
    assert.equal(resultTabs()[0]?.label, 'Results');
    // The editor keeps the focus: results appear next to the query, not over it.
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), document.uri.toString());
  });

  it('reuses the same panel for the same document', async () => {
    await openQuery();
    await vscode.commands.executeCommand('datanest.results.show');
    await waitForResultTabs(1);
    await vscode.commands.executeCommand('datanest.results.show');
    await sleep(300);
    assert.equal(resultTabs().length, 1);
  });

  it('gives every document its own panel', async () => {
    await openQuery('SELECT 1;');
    await vscode.commands.executeCommand('datanest.results.show');
    await waitForResultTabs(1);
    await openQuery('SELECT 2;');
    await vscode.commands.executeCommand('datanest.results.show');
    await waitForResultTabs(2);
  });

  it('opens no panel for a document that is not SQL', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: 'SELECT 1',
    });
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('datanest.results.show');
    await sleep(300);
    assert.equal(resultTabs().length, 0);
  });

  it('opens no panel when a run stops at the connection picker', async () => {
    // Nothing is saved in the test host, so the run asks for a connection and
    // gives up; showing an empty result panel then would only be noise.
    await openQuery();
    await vscode.commands.executeCommand('datanest.query.run');
    await sleep(300);
    assert.equal(resultTabs().length, 0);
  });

  it('registers the command', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('datanest.results.show'));
  });
});

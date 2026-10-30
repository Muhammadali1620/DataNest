// The tool pages of V8 in a real editor: each opens from its command on a SQLite
// connection of the project file, with its webview bundle.

import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { projectConnectionId } from '../../src/services/project-connections';
import { forgetProject } from './project-workspace';

const EXTENSION_ID = 'datanest.datanest';
const TAB_TIMEOUT_MS = 15_000;

async function runOn(connectionId: string, sql: string): Promise<void> {
  const document = await vscode.commands.executeCommand<vscode.TextDocument>(
    'datanest.query.new',
    connectionId,
  );
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((edit) => {
    edit.insert(new vscode.Position(0, 0), sql);
  });
  await vscode.commands.executeCommand('datanest.query.runAll');
}

function webviewTabs(viewType: string): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType),
    );
}

async function waitForTab(viewType: string): Promise<vscode.Tab> {
  const started = Date.now();
  for (;;) {
    const [tab] = webviewTabs(viewType);
    if (tab !== undefined) {
      return tab;
    }
    if (Date.now() - started > TAB_TIMEOUT_MS) {
      throw new Error(`No ${viewType} tab within ${TAB_TIMEOUT_MS} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('tool pages', () => {
  let root: string;
  let id: string;

  before(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the e2e editor opens a workspace folder');
    root = folder.uri.fsPath;
    mkdirSync(join(root, '.vscode'), { recursive: true });
    writeFileSync(
      join(root, '.vscode', 'datanest.json'),
      JSON.stringify({
        version: 1,
        connections: [{ id: 'tools', name: 'E2E tools', driver: 'sqlite', file: 'tools.db' }],
      }),
    );
    id = projectConnectionId(folder.uri.toString(), 'tools');
    await vscode.commands.executeCommand('datanest.tree.refresh');
    await runOn(
      id,
      `CREATE TABLE IF NOT EXISTS parents (id INTEGER PRIMARY KEY, name TEXT);
       CREATE TABLE IF NOT EXISTS children (id INTEGER PRIMARY KEY,
         parent_id INTEGER REFERENCES parents (id));`,
    );
  });

  after(async () => {
    await forgetProject(root, [id], ['tools.db']);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('opens the ER diagram of a connection (V8.1)', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('datanest.diagram.show', {
      kind: 'connection',
      connectionId: id,
    });
    const tab = await waitForTab('datanest.erDiagram');
    assert.equal(tab.label, 'ER Diagram: E2E tools');
  });
});

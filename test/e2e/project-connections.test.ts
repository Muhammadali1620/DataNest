// Project connections in a real editor (V4.7): a `.vscode/datanest.json` written into
// the open folder is picked up by the file watcher, and its SQLite connection runs a
// statement through the whole command path — no form, no saved state.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { projectConnectionId } from '../../src/services/project-connections';
import { forgetProject } from './project-workspace';

const EXTENSION_ID = 'datanest.datanest';

interface RunOutcome {
  readonly results: readonly { readonly rowCount: number; readonly error?: { message: string } }[];
}

/** Opens a query bound to the connection and runs it; the outcome the command returns. */
async function runOn(connectionId: string, sql: string): Promise<RunOutcome | undefined> {
  const document = await vscode.commands.executeCommand<vscode.TextDocument>(
    'datanest.query.new',
    connectionId,
  );
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((edit) => {
    edit.insert(new vscode.Position(0, 0), sql);
  });
  return await vscode.commands.executeCommand<RunOutcome>('datanest.query.runAll');
}

describe('project connections', () => {
  let root: string;
  let folder: vscode.WorkspaceFolder;

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const first = vscode.workspace.workspaceFolders?.[0];
    assert.ok(first, 'the e2e editor opens a workspace folder');
    folder = first;
    root = folder.uri.fsPath;
  });

  after(async () => {
    await forgetProject(root, [projectConnectionId(folder.uri.toString(), 'e2e')], ['project.db']);
  });

  it('registers the project commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'datanest.connections.moveToProject',
      'datanest.connections.moveToUser',
      'datanest.project.openFile',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  it('runs a statement on a connection from the project file, with a relative path', async () => {
    mkdirSync(join(root, '.vscode'), { recursive: true });
    writeFileSync(
      join(root, '.vscode', 'datanest.json'),
      JSON.stringify({
        version: 1,
        // A comment-free file is plain JSON; the reader accepts JSONC too.
        connections: [
          {
            id: 'e2e',
            name: 'E2E project',
            driver: 'sqlite',
            file: 'project.db',
            // Every session runs it first (V4.9); the statement below sees its effect.
            options: { initSql: 'PRAGMA user_version = 7' },
          },
        ],
      }),
    );
    const id = projectConnectionId(folder.uri.toString(), 'e2e');
    // The file watcher would read it on its own, but when is up to the editor;
    // Refresh of the whole tree reads project files at once.
    await vscode.commands.executeCommand('datanest.tree.refresh');
    const outcome = await runOn(id, 'SELECT 1 AS one');
    assert.equal(outcome?.results[0]?.error, undefined, outcome?.results[0]?.error?.message);
    assert.equal(outcome?.results[0]?.rowCount, 1);
    // The relative file path starts at the workspace folder.
    assert.ok(existsSync(join(root, 'project.db')), 'the database file is in the folder');
    const init = await runOn(
      id,
      'SELECT 1 WHERE (SELECT user_version FROM pragma_user_version) = 7',
    );
    assert.equal(init?.results[0]?.rowCount, 1, 'the init SQL ran on the session');
  });

  it('opens the project file from the command', async () => {
    await vscode.commands.executeCommand('datanest.project.openFile');
    const active = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    assert.ok(active.endsWith(join('.vscode', 'datanest.json')), active);
  });

  it('creates the project file when it is missing', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // The file, not the folder: on Windows the editor's watcher keeps `.vscode` open.
    rmSync(join(root, '.vscode', 'datanest.json'), { force: true });
    await vscode.commands.executeCommand('datanest.project.openFile');
    // The editor may still show the closed document's old text for a moment; the
    // file on disk is what the command wrote.
    const text = readFileSync(join(root, '.vscode', 'datanest.json'), 'utf8');
    assert.deepEqual(JSON.parse(text), { version: 1, connections: [] });
    const active = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    assert.ok(active.endsWith(join('.vscode', 'datanest.json')), active);
  });
});

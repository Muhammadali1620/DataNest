// Manual commit in a real editor (V4.8): with the editor switched to manual commit, a
// change waits in a transaction that Rollback undoes and Commit keeps. The connection
// comes from a project file, so no form is needed (V4.7).

import * as assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { projectConnectionId } from '../../src/services/project-connections';
import { forgetProject } from './project-workspace';

const EXTENSION_ID = 'datanest.datanest';

interface RunOutcome {
  readonly results: readonly { readonly rowCount: number; readonly error?: { message: string } }[];
}

/** Puts `sql` into the editor and runs all of it. */
async function runAll(editor: vscode.TextEditor, sql: string): Promise<RunOutcome> {
  await editor.edit((edit) => {
    const whole = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length),
    );
    edit.replace(whole, sql);
  });
  const outcome = await vscode.commands.executeCommand<RunOutcome>('datanest.query.runAll');
  assert.ok(outcome, 'the run returned nothing');
  for (const result of outcome.results) {
    assert.equal(result.error, undefined, result.error?.message);
  }
  return outcome;
}

describe('manual commit', () => {
  let root: string;
  let connectionId: string;
  let editor: vscode.TextEditor;

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the e2e editor opens a workspace folder');
    root = folder.uri.fsPath;
    // A fresh file: a DROP here would stop at the safe mode question.
    rmSync(join(root, 'tx.db'), { force: true });
    mkdirSync(join(root, '.vscode'), { recursive: true });
    writeFileSync(
      join(root, '.vscode', 'datanest.json'),
      JSON.stringify({
        connections: [{ id: 'tx', name: 'Transactions', driver: 'sqlite', file: 'tx.db' }],
      }),
    );
    await vscode.commands.executeCommand('datanest.tree.refresh');
    connectionId = projectConnectionId(folder.uri.toString(), 'tx');
    const document = await vscode.commands.executeCommand<vscode.TextDocument>(
      'datanest.query.new',
      connectionId,
    );
    editor = await vscode.window.showTextDocument(document);
  });

  after(async () => {
    await forgetProject(root, [connectionId], ['tx.db']);
  });

  it('registers the transaction commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'datanest.transaction.commit',
      'datanest.transaction.rollback',
      'datanest.transaction.toggleMode',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  it('starts in auto-commit, as the setting says', () => {
    assert.equal(vscode.workspace.getConfiguration('datanest').get('transactionMode'), 'auto');
  });

  it('undoes the changes of a manual transaction on Rollback', async () => {
    await vscode.commands.executeCommand('datanest.transaction.toggleMode');
    await runAll(editor, 'CREATE TABLE tx_probe (id INTEGER);\nINSERT INTO tx_probe VALUES (1);');
    await vscode.commands.executeCommand('datanest.transaction.rollback');
    const outcome = await runAll(editor, "SELECT name FROM sqlite_master WHERE name = 'tx_probe'");
    assert.equal(outcome.results[0]?.rowCount, 0, 'the table was rolled back with its row');
  });

  it('keeps the changes of a manual transaction on Commit', async () => {
    await runAll(editor, 'CREATE TABLE tx_probe (id INTEGER);\nINSERT INTO tx_probe VALUES (1);');
    await vscode.commands.executeCommand('datanest.transaction.commit');
    // Switching back to auto-commit: a rollback now has nothing to undo.
    await vscode.commands.executeCommand('datanest.transaction.toggleMode');
    const outcome = await runAll(editor, 'SELECT id FROM tx_probe');
    assert.equal(outcome.results[0]?.rowCount, 1);
  });
});

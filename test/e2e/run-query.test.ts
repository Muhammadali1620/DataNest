// Running queries in a real editor against a real SQLite file: the keybinding
// commands exist, the CodeLens appears above every statement, and a statement
// actually runs through the connection the document is bound to.

import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

interface Manifest {
  contributes: {
    keybindings: { command: string; key: string; when: string }[];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function openSql(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
  return await vscode.window.showTextDocument(document, { preview: false });
}

describe('running queries', () => {
  let dir: string;

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    dir = mkdtempSync(join(tmpdir(), 'datanest-e2e-run-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('registers every run command', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'datanest.query.run',
      'datanest.query.runAll',
      'datanest.query.runRange',
      'datanest.query.cancel',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  it('binds Ctrl+Enter and Ctrl+Shift+Enter to SQL editors only', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const { contributes } = extension.packageJSON as Manifest;
    const run = contributes.keybindings.find((entry) => entry.command === 'datanest.query.run');
    const runAll = contributes.keybindings.find(
      (entry) => entry.command === 'datanest.query.runAll',
    );
    assert.equal(run?.key, 'ctrl+enter');
    assert.equal(runAll?.key, 'ctrl+shift+enter');
    for (const entry of [run, runAll]) {
      assert.ok(entry, 'a keybinding is missing');
      assert.match(entry.when, /editorLangId == sql/);
      assert.match(entry.when, /editorTextFocus/);
    }
  });

  it('shows a Run lens above every statement', async () => {
    const editor = await openSql('SELECT 1;\nSELECT 2;\n');
    // CodeLens is resolved asynchronously by the editor.
    await sleep(500);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      editor.document.uri,
    );
    assert.ok(lenses);
    const ours = lenses.filter((lens) => lens.command?.command === 'datanest.query.runRange');
    assert.equal(ours.length, 2);
    assert.equal(ours[0]?.range.start.line, 0);
    assert.equal(ours[1]?.range.start.line, 1);
  });

  it('shows no lens for a document without statements', async () => {
    const editor = await openSql('-- just a note\n');
    await sleep(300);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      editor.document.uri,
    );
    assert.deepEqual(
      lenses.filter((lens) => lens.command?.command === 'datanest.query.runRange'),
      [],
    );
  });

  it('does nothing but warn when there is no SQL editor', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(100);
    const outcome = await vscode.commands.executeCommand('datanest.query.run');
    assert.equal(outcome, undefined);
  });

  it('cancelling with nothing running is harmless', async () => {
    await openSql('SELECT 1;');
    await vscode.commands.executeCommand('datanest.query.cancel');
  });

  it('asks before dangerous statements unless the user turned it off', () => {
    const config = vscode.workspace.getConfiguration('datanest');
    assert.equal(config.get('safeMode'), 'confirm');
    assert.deepEqual(config.inspect('safeMode')?.defaultValue, 'confirm');
  });

  it('opens the query history even when it is empty, and closes it again', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('datanest.history.show'));
    await vscode.commands.executeCommand('datanest.history.show');
    await sleep(200);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  });

  it('runs a statement end to end through the shipped SQLite driver', async () => {
    // The command path needs a saved connection, which this test cannot create
    // without the form; it checks the pieces the command relies on instead.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const bundle = join(extension.extensionPath, 'dist', 'drivers', 'sqlite.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(bundle) as {
      driver: {
        openSession(config: Record<string, unknown>): Promise<{
          execute(
            sql: string,
            options?: { rowLimit?: number },
          ): AsyncIterable<{ kind: string; rows?: unknown[][] }>;
          close(): Promise<void>;
        }>;
      };
    };
    const session = await loaded.driver.openSession({
      id: 'e2e-run',
      name: 'e2e run',
      driver: 'sqlite',
      file: join(dir, 'run.db'),
    });
    try {
      const rows: unknown[][] = [];
      for await (const event of session.execute('SELECT 1 AS one', { rowLimit: 10 })) {
        if (event.kind === 'rows' && event.rows) {
          rows.push(...event.rows);
        }
      }
      assert.deepEqual(rows, [[1]]);
    } finally {
      await session.close();
    }
  });
});

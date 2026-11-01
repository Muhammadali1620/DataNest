// SQL notebooks in a real editor (V12.1): a `.sqlnb` file opens as a notebook, a cell runs
// on the connection of the notebook (a project connection named by its id in the file)
// and its result appears under it; a temporary table made in one cell is there in the next.

import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { projectConnectionId } from '../../src/services/project-connections';
import { forgetProject } from './project-workspace';

const EXTENSION_ID = 'datanest.datanest';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function textOf(cell: vscode.NotebookCell): string {
  return cell.outputs
    .flatMap((output) => output.items)
    .map((item) => `${item.mime}: ${new TextDecoder().decode(item.data)}`)
    .join('\n');
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('SQL notebooks', () => {
  let root: string;
  let dir: string;
  let folder: vscode.WorkspaceFolder;

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const first = vscode.workspace.workspaceFolders?.[0];
    assert.ok(first, 'the e2e editor opens a workspace folder');
    folder = first;
    root = folder.uri.fsPath;
    dir = mkdtempSync(join(tmpdir(), 'datanest-e2e-notebook-'));
  });

  after(async () => {
    await forgetProject(root, [projectConnectionId(folder.uri.toString(), 'nb')], ['notebook.db']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers the notebook commands and the notebook type', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['datanest.notebook.new', 'datanest.notebook.selectConnection']) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  it('opens a file as a notebook with its cells and connection', async () => {
    const file = join(dir, 'open.sqlnb');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connection: 'nb',
        cells: [
          { kind: 'markdown', source: ['# Title'] },
          { kind: 'sql', source: ['SELECT 1;'] },
        ],
      }),
    );
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
    assert.equal(notebook.notebookType, 'datanest-sql');
    assert.equal(notebook.cellCount, 2);
    assert.equal(notebook.cellAt(0).kind, vscode.NotebookCellKind.Markup);
    assert.equal(notebook.cellAt(1).document.getText(), 'SELECT 1;');
    assert.equal(notebook.cellAt(1).document.languageId, 'sql');
    assert.equal((notebook.metadata as { connection?: string }).connection, 'nb');
  });

  it('opens an empty file as a notebook with one empty SQL cell', async () => {
    const file = join(dir, 'empty.sqlnb');
    writeFileSync(file, '');
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
    assert.equal(notebook.cellCount, 1);
    assert.equal(notebook.cellAt(0).document.getText(), '');
  });

  it('runs cells on the connection of the notebook, in one session', async () => {
    mkdirSync(join(root, '.vscode'), { recursive: true });
    writeFileSync(
      join(root, '.vscode', 'datanest.json'),
      JSON.stringify({
        version: 1,
        connections: [{ id: 'nb', name: 'Notebook DB', driver: 'sqlite', file: 'notebook.db' }],
      }),
    );
    await vscode.commands.executeCommand('datanest.tree.refresh');
    const file = join(dir, 'run.sqlnb');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connection: 'nb',
        cells: [
          { kind: 'sql', source: ['CREATE TEMP TABLE t (id INTEGER, name TEXT);'] },
          { kind: 'sql', source: ["INSERT INTO t VALUES (1, 'apple'), (2, '<b>pear</b>');"] },
          { kind: 'sql', source: ['SELECT id, name FROM t ORDER BY id;'] },
        ],
      }),
    );
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
    await vscode.window.showNotebookDocument(notebook);
    await sleep(300);
    await vscode.commands.executeCommand('notebook.execute');
    const last = notebook.cellAt(2);
    await waitFor(
      () => (last.outputs.length > 0 ? true : undefined),
      'the result of the last cell',
    );
    const output = textOf(last);
    assert.match(output, /text\/html: <table/u);
    assert.match(output, /apple/u);
    // A value never becomes markup in the HTML (the plain text may hold it as it is).
    const html = new TextDecoder().decode(
      last.outputs.flatMap((item) => item.items).find((item) => item.mime === 'text/html')?.data,
    );
    assert.doesNotMatch(html, /<b>pear/u);
    assert.match(html, /&lt;b&gt;pear/u);
    assert.match(textOf(notebook.cellAt(1)), /2 rows affected/u);
  });

  it('shows the error of a statement under its cell and stops the cells after it', async () => {
    const file = join(dir, 'error.sqlnb');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connection: 'nb',
        cells: [
          { kind: 'sql', source: ['SELECT * FROM no_such_table;'] },
          { kind: 'sql', source: ['SELECT 1;'] },
        ],
      }),
    );
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
    await vscode.window.showNotebookDocument(notebook);
    await sleep(300);
    await vscode.commands.executeCommand('notebook.execute');
    const first = notebook.cellAt(0);
    await waitFor(() => (first.outputs.length > 0 ? true : undefined), 'the error');
    assert.match(textOf(first), /no_such_table/u);
    await sleep(300);
    assert.equal(notebook.cellAt(1).outputs.length, 0);
  });
});

// Format Document in a real editor: the provider is registered for SQL, loads the
// sql-formatter bundle on first use and keeps DELIMITER commands intact.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

async function format(content: string): Promise<string> {
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
  const editor = await vscode.window.showTextDocument(document);
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.ok(edits, 'no formatting provider answered');
  await editor.edit((builder) => {
    for (const edit of edits) {
      builder.replace(edit.range, edit.newText);
    }
  });
  return document.getText();
}

describe('formatting', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('formats every statement of a SQL document', async () => {
    assert.equal(
      await format('select a, b from t where x = 1;\nselect 2;'),
      'SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1;\nSELECT\n  2;',
    );
  });

  it('leaves DELIMITER commands and broken statements as they are', async () => {
    const text = await format('DELIMITER //\nselect 1//\nDELIMITER ;\nselect (;\n');
    assert.equal(text, 'DELIMITER //\nSELECT\n  1//\nDELIMITER ;\nselect (;\n');
  });

  it('reads the format settings of the folder the document lives in', async () => {
    // The format settings are resource-scoped: they are read for the document, so a
    // folder of a multi-root workspace can have its own style.
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the e2e host has no workspace folder');
    const file = vscode.Uri.joinPath(folder.uri, 'format-scope.sql');
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('SELECT a FROM t;'));
    const config = vscode.workspace.getConfiguration('datanest.format', file);
    await config.update('keywordCase', 'lower', vscode.ConfigurationTarget.WorkspaceFolder);
    try {
      const document = await vscode.workspace.openTextDocument(file);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        document.uri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.ok(edits, 'no formatting provider answered');
      // Applied to the text, not the document: a dirty file would ask to be saved.
      let text = document.getText();
      for (const edit of [...edits].sort(
        (a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start),
      )) {
        text =
          text.slice(0, document.offsetAt(edit.range.start)) +
          edit.newText +
          text.slice(document.offsetAt(edit.range.end));
      }
      // The formatter keeps the document's line ends: CRLF where the editor uses them (Windows).
      assert.equal(text.replace(/\r\n/g, '\n'), 'select\n  a\nfrom\n  t;');
    } finally {
      await config.update('keywordCase', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await vscode.workspace.fs.delete(file);
    }
  });
});

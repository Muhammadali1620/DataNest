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
});

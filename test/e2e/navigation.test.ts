// Hover and Go to Definition in a real editor. Without a connection, what the
// statement defines for itself (a CTE) still has a hover, and nothing else breaks.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

async function openSql(content: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

function hoverText(hovers: readonly vscode.Hover[]): string {
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (content instanceof vscode.MarkdownString ? content.value : ''))
    .join('\n');
}

describe('navigation', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('shows the columns of a CTE on hover', async () => {
    const text = 'WITH big AS (SELECT id, total FROM orders) SELECT * FROM big';
    const document = await openSql(text);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      document.positionAt(text.lastIndexOf('big') + 1),
    );
    const shown = hoverText(hovers);
    assert.ok(shown.includes('**big**'), shown);
    assert.ok(shown.includes('`id`, `total`'), shown);
  });

  it('has no definition to go to without a connection', async () => {
    const text = 'SELECT * FROM orders';
    const document = await openSql(text);
    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      document.positionAt(text.indexOf('orders') + 1),
    );
    assert.deepEqual(locations, []);
  });

  it('serves DDL documents of its own scheme, empty for an unknown target', async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.from({ scheme: 'datanest-ddl', path: '/x.sql', query: 'not json' }),
    );
    assert.equal(document.getText(), '');
    assert.equal(document.languageId, 'sql');
  });
});

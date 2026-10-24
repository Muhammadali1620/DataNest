// Completion in a real editor. Without a connection only keywords are known,
// which is exactly what a user sees before choosing one.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

async function openSql(content: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

async function completeAt(
  document: vscode.TextDocument,
  offset: number,
): Promise<vscode.CompletionList> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    document.positionAt(offset),
  );
  assert.ok(list, 'the completion provider returned nothing');
  return list;
}

function labels(list: vscode.CompletionList): string[] {
  return list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
}

describe('completion', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('offers keywords in a fresh query', async () => {
    const document = await openSql('SEL');
    const list = await completeAt(document, 3);
    assert.ok(labels(list).includes('SELECT'), 'SELECT was not offered');
  });

  it('offers keywords where a column belongs', async () => {
    const document = await openSql('SELECT ');
    const list = await completeAt(document, 7);
    assert.ok(labels(list).includes('COUNT'), 'COUNT was not offered');
  });

  it('offers nothing inside a string', async () => {
    const document = await openSql("SELECT 'SEL");
    const list = await completeAt(document, 11);
    // Other providers (word-based) may still answer; ours must not add keywords.
    assert.equal(
      list.items.filter((item) => item.kind === vscode.CompletionItemKind.Keyword).length,
      0,
    );
  });

  it('offers nothing inside a comment', async () => {
    const document = await openSql('-- SEL');
    const list = await completeAt(document, 6);
    assert.equal(
      list.items.filter((item) => item.kind === vscode.CompletionItemKind.Keyword).length,
      0,
    );
  });

  it('does not answer for documents that are not SQL', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: 'SELECT ',
    });
    await vscode.window.showTextDocument(document, { preview: false });
    const list = await completeAt(document, 7);
    assert.equal(
      list.items.filter((item) => item.kind === vscode.CompletionItemKind.Keyword).length,
      0,
    );
  });
});

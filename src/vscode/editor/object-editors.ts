// The editor side of object editing: a context key for the "Apply" button, a lens
// above the definition, and forgetting a document when it closes.

import * as vscode from 'vscode';
import { COMMAND_IDS, CONTEXT_KEYS } from '../command-ids';
import type { ObjectEditRegistry } from './object-edit';

export class ObjectEditors implements vscode.Disposable, vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly registry: ObjectEditRegistry) {
    this.subscriptions.push(
      this.changed,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateContext();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        registry.forget(document.uri.toString());
      }),
      registry.onDidChange(() => {
        this.updateContext();
        this.changed.fire();
      }),
      vscode.languages.registerCodeLensProvider({ language: 'sql' }, this),
    );
    this.updateContext();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const uri = document.uri.toString();
    const edit = this.registry.get(uri);
    if (edit === undefined) {
      return [];
    }
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        title: vscode.l10n.t('$(check) Apply to {0} {1}', edit.object.kind, edit.object.name),
        command: COMMAND_IDS.applyObject,
        arguments: [uri],
      }),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  private updateContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    const editing = uri !== undefined && this.registry.get(uri) !== undefined;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEYS.objectEditor, editing);
  }
}

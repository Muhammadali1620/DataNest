// How SQL editors show their statements (V10.2.2): the statement under the cursor is
// highlighted when a file holds several, and statements fold. Both follow settings.

import * as vscode from 'vscode';
import { foldingRanges, type FoldKind } from '../../core/sql/folding';
import { splitStatements, type SqlStatement, statementIndexAt } from '../../core/sql/split';
import type { DriverId } from '../../shared/connection';
import { SQL_LANGUAGE_ID } from './query-editor';

/** Bigger documents are not split on every cursor move. */
const MAX_HIGHLIGHT_LENGTH = 1_000_000;

/** Waits this long after the last move or keystroke before highlighting. */
const HIGHLIGHT_DELAY_MS = 120;

export interface StatementViewDeps {
  /** The driver of a document's connection, for dialect-aware splitting. */
  readonly driverOf: (documentUri: string) => DriverId | undefined;
  readonly highlight: () => boolean;
  readonly fold: () => boolean;
}

interface Split {
  readonly uri: string;
  readonly version: number;
  readonly driver: DriverId | undefined;
  readonly statements: readonly SqlStatement[];
}

const FOLD_KINDS: Readonly<Record<FoldKind, vscode.FoldingRangeKind | undefined>> = {
  statement: undefined,
  indent: undefined,
  comment: vscode.FoldingRangeKind.Comment,
  region: vscode.FoldingRangeKind.Region,
};

export class StatementView implements vscode.Disposable, vscode.FoldingRangeProvider {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('datanest.statementHighlightBackground'),
    isWholeLine: true,
  });
  private readonly subscriptions: vscode.Disposable[] = [];
  private folding: vscode.Disposable | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private split: Split | undefined;

  constructor(private readonly deps: StatementViewDeps) {
    this.subscriptions.push(
      this.decoration,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.schedule();
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.schedule();
        }
      }),
    );
    this.applySettings();
  }

  /** Settings or the editor's connection changed: register, unregister, redraw. */
  applySettings(): void {
    if (this.deps.fold() && this.folding === undefined) {
      this.folding = vscode.languages.registerFoldingRangeProvider(
        { language: SQL_LANGUAGE_ID },
        this,
      );
    } else if (!this.deps.fold() && this.folding !== undefined) {
      this.folding.dispose();
      this.folding = undefined;
    }
    this.split = undefined;
    this.schedule();
  }

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const driver = this.deps.driverOf(document.uri.toString());
    return foldingRanges(document.getText(), driver).map(
      (fold) => new vscode.FoldingRange(fold.start, fold.end, FOLD_KINDS[fold.kind]),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.folding?.dispose();
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.highlight();
    }, HIGHLIGHT_DELAY_MS);
  }

  private highlight(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      return;
    }
    const { document } = editor;
    if (
      document.languageId !== SQL_LANGUAGE_ID ||
      !this.deps.highlight() ||
      document.getText().length > MAX_HIGHLIGHT_LENGTH
    ) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const statements = this.statementsOf(document);
    const index = statementIndexAt(statements, document.offsetAt(editor.selection.active));
    const statement = index === undefined ? undefined : statements[index];
    // With one statement there is nothing to tell apart; a selection is what runs.
    if (statement === undefined || statements.length < 2 || !editor.selection.isEmpty) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    editor.setDecorations(this.decoration, [
      new vscode.Range(document.positionAt(statement.start), document.positionAt(statement.end)),
    ]);
  }

  private statementsOf(document: vscode.TextDocument): readonly SqlStatement[] {
    const uri = document.uri.toString();
    const driver = this.deps.driverOf(uri);
    const cached = this.split;
    if (cached?.uri === uri && cached.version === document.version && cached.driver === driver) {
      return cached.statements;
    }
    const statements = splitStatements(document.getText(), driver);
    this.split = { uri, version: document.version, driver, statements };
    return statements;
  }
}

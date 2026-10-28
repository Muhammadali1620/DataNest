// The error of a failed statement as a red squiggle in its editor and an entry in
// Problems (V3.11). A new run replaces them; editing the text drops the ones the
// edit touched or moved.

import * as vscode from 'vscode';
import { errorMarkers } from '../../services/error-markers';
import type { ResultSummary } from '../../services/result-store';
import type { DriverId } from '../../shared/connection';

export class ErrorDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('datanest');
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      this.collection,
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.edited(event);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.collection.delete(document.uri);
      }),
    );
  }

  /** Shows the errors of one run of a document, replacing those of the run before. */
  show(documentUri: string, results: readonly ResultSummary[], driver: DriverId | undefined): void {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === documentUri,
    );
    if (document === undefined) {
      return;
    }
    const diagnostics = errorMarkers(document.getText(), results, driver).map((marker) => {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(document.positionAt(marker.start), document.positionAt(marker.end)),
        marker.message,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = 'DataNest';
      diagnostic.code = marker.code;
      return diagnostic;
    });
    this.collection.set(document.uri, diagnostics);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  /** Markers before the first change keep their place; the rest no longer point right. */
  private edited(event: vscode.TextDocumentChangeEvent): void {
    const current = this.collection.get(event.document.uri);
    if (current === undefined || current.length === 0 || event.contentChanges.length === 0) {
      return;
    }
    const first = event.contentChanges.reduce(
      (earliest, change) => (change.range.start.isBefore(earliest) ? change.range.start : earliest),
      event.contentChanges[0]?.range.start ?? new vscode.Position(0, 0),
    );
    this.collection.set(
      event.document.uri,
      current.filter((diagnostic) => diagnostic.range.end.isBefore(first)),
    );
  }
}

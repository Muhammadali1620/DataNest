// Format Document and Format Selection for SQL editors. The dialect follows the
// connection the document is bound to; sql-formatter loads on the first use.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { ConnectionStore } from '../../services/connection-store';
import { type FormatterLoader, formatEdits } from '../../services/sql-format';
import { readFormatStyle } from '../settings';
import type { DocumentBindings } from './document-bindings';

export interface FormattingDeps {
  readonly bindings: DocumentBindings;
  readonly store: ConnectionStore;
  readonly loadFormatter: FormatterLoader;
  readonly logger: Logger;
}

export class SqlFormattingProvider
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider
{
  private readonly logger: Logger;

  constructor(private readonly deps: FormattingDeps) {
    this.logger = deps.logger.child('format');
  }

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    return this.edits(document, options);
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    return this.edits(document, options, {
      from: document.offsetAt(range.start),
      to: document.offsetAt(range.end),
    });
  }

  private edits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    range?: { from: number; to: number },
  ): vscode.TextEdit[] {
    const binding = this.deps.bindings.get(document.uri.toString());
    const driver =
      binding === undefined ? undefined : this.deps.store.get(binding.connectionId)?.driver;
    const result = formatEdits(
      document.getText(),
      driver,
      readFormatStyle(options, document),
      this.deps.loadFormatter(),
      range,
    );
    if (result.failed > 0) {
      this.logger.debug(`Left ${result.failed} statement(s) unformatted: ${result.reason ?? ''}`);
      void vscode.window.setStatusBarMessage(
        vscode.l10n.t(
          'DataNest: {0} statement(s) could not be read and were left as they are',
          result.failed,
        ),
        5000,
      );
    }
    return result.edits.map(
      (edit) =>
        new vscode.TextEdit(
          new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
          edit.text,
        ),
    );
  }
}

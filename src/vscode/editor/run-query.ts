import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { splitStatements, statementsIn, type SqlStatement } from '../../core/sql/split';
import type { QueryRunner, RunOutcome } from '../../services/query-runner';
import type { ConnectionStore } from '../../services/connection-store';
import { COMMAND_IDS } from '../command-ids';
import type { DriverId } from '../../shared/connection';
import type { DocumentBinding } from './document-bindings';
import type { QueryEditors } from './query-editor';
import { SQL_LANGUAGE_ID } from './query-editor';

export interface RunQueryDeps {
  readonly runner: QueryRunner;
  readonly editors: QueryEditors;
  readonly store: ConnectionStore;
  readonly logger: Logger;
}

export type RunCommandName = 'run' | 'runAll' | 'cancel' | 'runRange';

/** A range the CodeLens passes along, as plain numbers so it survives commands. */
export interface RunRangeArgs {
  readonly documentUri: string;
  readonly start: number;
  readonly end: number;
}

export function runCommandHandlers(
  deps: RunQueryDeps,
): Record<RunCommandName, (args?: unknown) => unknown> {
  const run = async (statements: readonly SqlStatement[]): Promise<RunOutcome | undefined> => {
    const editor = sqlEditor();
    if (editor === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
      );
      return undefined;
    }
    if (statements.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to run'));
      return undefined;
    }
    const documentUri = editor.document.uri.toString();
    const target = await resolveTarget(deps, documentUri);
    if (target === undefined) {
      return undefined;
    }
    const outcome = await deps.runner.run({ documentUri, target, statements });
    report(outcome, deps.logger);
    return outcome;
  };

  return {
    /** The selection, or the statement the cursor is in. */
    run: async () => {
      const editor = sqlEditor();
      if (editor === undefined) {
        return await run([]);
      }
      const { document, selection } = editor;
      const text = document.getText();
      const from = document.offsetAt(selection.start);
      const to = document.offsetAt(selection.end);
      const driver = driverOf(deps, document.uri.toString());
      return await run(statementsIn(text, from, to, driver));
    },

    runAll: async () => {
      const editor = sqlEditor();
      if (editor === undefined) {
        return await run([]);
      }
      const driver = driverOf(deps, editor.document.uri.toString());
      return await run(splitStatements(editor.document.getText(), driver));
    },

    /** Runs one statement by its offsets; used by the CodeLens above it. */
    runRange: async (args?: unknown) => {
      const range = asRunRange(args);
      if (range === undefined) {
        return undefined;
      }
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === range.documentUri,
      );
      if (document === undefined) {
        return undefined;
      }
      const text = document.getText();
      return await run([
        { text: text.slice(range.start, range.end), start: range.start, end: range.end },
      ]);
    },

    cancel: async () => {
      const editor = sqlEditor();
      const documentUri = editor?.document.uri.toString();
      if (documentUri === undefined) {
        return undefined;
      }
      await deps.runner.cancel(documentUri);
      return undefined;
    },
  };
}

/** The active editor, but only when it holds SQL. */
function sqlEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.languageId === SQL_LANGUAGE_ID ? editor : undefined;
}

/** The connection of a document, asking the user to pick one if it has none. */
async function resolveTarget(
  deps: RunQueryDeps,
  documentUri: string,
): Promise<DocumentBinding | undefined> {
  const existing = deps.editors.bindings.get(documentUri);
  if (existing !== undefined) {
    return existing;
  }
  return await deps.editors.selectConnection();
}

/** The driver of a document's connection, for dialect-aware splitting. */
function driverOf(deps: RunQueryDeps, documentUri: string): DriverId | undefined {
  const binding = deps.editors.bindings.get(documentUri);
  if (binding === undefined) {
    return undefined;
  }
  return deps.store.get(binding.connectionId)?.driver;
}

/** One short line about the run; the details land in the result panel (V1.19). */
function report(outcome: RunOutcome, logger: Logger): void {
  const failed = outcome.results.filter((result) => result.error !== undefined);
  const first = failed[0];
  if (first?.error !== undefined) {
    if (first.error.code === 'cancelled') {
      void vscode.window.setStatusBarMessage(vscode.l10n.t('Query cancelled'), 3000);
      return;
    }
    void vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', first.error.message));
    return;
  }
  if (outcome.cancelled) {
    void vscode.window.setStatusBarMessage(vscode.l10n.t('Query cancelled'), 3000);
    return;
  }
  const last = outcome.results.at(-1);
  if (last === undefined) {
    return;
  }
  const summary =
    last.affectedRows === undefined
      ? vscode.l10n.t('{0} rows in {1} ms', last.rowCount, last.durationMs)
      : vscode.l10n.t('{0} rows affected in {1} ms', last.affectedRows, last.durationMs);
  logger.info(
    `Ran ${outcome.results.length} statement(s): ${summary}${last.truncated ? ' (truncated)' : ''}`,
  );
  void vscode.window.setStatusBarMessage(`DataNest: ${summary}`, 5000);
}

function asRunRange(args: unknown): RunRangeArgs | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const { documentUri, start, end } = args as Partial<RunRangeArgs>;
  if (
    typeof documentUri !== 'string' ||
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    end < start
  ) {
    return undefined;
  }
  return { documentUri, start, end };
}

/**
 * A "▶ Run" lens above every statement. The lens carries offsets, so it keeps
 * working while the user edits around it.
 */
export class RunCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly deps: RunQueryDeps) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== SQL_LANGUAGE_ID) {
      return [];
    }
    const driver = driverOf(this.deps, document.uri.toString());
    const text = document.getText();
    return splitStatements(text, driver).map((statement) => {
      const range = new vscode.Range(
        document.positionAt(statement.start),
        document.positionAt(statement.end),
      );
      const args: RunRangeArgs = {
        documentUri: document.uri.toString(),
        start: statement.start,
        end: statement.end,
      };
      return new vscode.CodeLens(range, {
        title: vscode.l10n.t('$(play) Run'),
        command: COMMAND_IDS.runRange,
        arguments: [args],
      });
    });
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

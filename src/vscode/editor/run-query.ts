import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { splitStatements, statementsIn, type SqlStatement } from '../../core/sql/split';
import type { QueryRunner, RunOutcome, RunRequest } from '../../services/query-runner';
import type { ConnectionStore } from '../../services/connection-store';
import { type Danger } from '../../core/sql/danger';
import { commitsImplicitly } from '../../core/sql/transaction-control';
import type { TransactionState } from '../../drivers/driver';
import { riskyStatements, type RiskyStatement } from '../../services/safe-mode';
import { policyOf, runVerdict, type WritePolicy } from '../../services/write-policy';
import { summaryLine } from '../../services/history-format';
import { type FilledStatements, inDocument } from '../../services/query-variables';
import type { Substitution } from '../../core/sql/variables';
import { readSafeMode } from '../settings';
import { COMMAND_IDS } from '../command-ids';
import type { DriverId } from '../../shared/connection';
import { type SqlTextOutcome, sqlTextOutcome } from '../../services/sql-text-outcome';
import type { SessionTarget } from '../../services/connection-manager';
import type { DocumentBinding } from './document-bindings';
import type { QueryEditors } from './query-editor';
import { SQL_LANGUAGE_ID } from './query-editor';

export interface RunQueryDeps {
  readonly runner: QueryRunner;
  readonly editors: QueryEditors;
  readonly store: ConnectionStore;
  readonly logger: Logger;
  /** Opens (or reveals) the result panel of a document. */
  readonly showResults: (documentUri: string) => void;
  /** Marks the errors of a run in its editor. */
  readonly diagnostics?: {
    show(documentUri: string, results: RunOutcome['results'], driver: DriverId | undefined): void;
  };
  /** True when the document runs in manual commit mode (V4.8). */
  readonly isManual?: (documentUri: string) => boolean;
  /** The transaction of the document's session, as the server last reported it. */
  readonly transactionState?: (documentUri: string) => TransactionState | undefined;
  /** False hides the Run lenses (V10.2.2). */
  readonly codeLens?: () => boolean;
  /** Asks for the values of query variables (V10.2.1); undefined when cancelled. */
  readonly fillVariables?: (
    statements: readonly SqlStatement[],
    connectionId: string,
    driver: DriverId | undefined,
  ) => Promise<FilledStatements | undefined>;
}

export type RunCommandName = 'run' | 'runAll' | 'cancel' | 'runRange';

/** What the SQL line of the result page asks for (V12.1). */
export interface SqlTextRequest {
  /** The document the result belongs to: an editor, or a table view. */
  readonly documentUri: string;
  readonly target: SessionTarget;
  readonly sql: string;
  /** What the new results replace: the result the text was edited on, or all of a table view's. */
  readonly replace?: RunRequest['replace'];
}

export type SqlTextRunner = (request: SqlTextRequest) => Promise<SqlTextOutcome>;

/**
 * Runs SQL typed on the result page like Run does: same policy, safe mode, variables and
 * transaction questions, same session of the document; its results replace the document's.
 */
export function sqlTextRunner(deps: RunQueryDeps): SqlTextRunner {
  return async ({ documentUri, target, sql, replace }) => {
    const driver = deps.store.get(target.connectionId)?.driver;
    const written = splitStatements(sql, driver);
    if (written.length === 0) {
      return { ok: false, error: vscode.l10n.t('Nothing to run') };
    }
    const policy = policyOf(deps.store.get(target.connectionId));
    const filled =
      deps.fillVariables === undefined
        ? { statements: written, substitutions: new Map<number, Substitution>() }
        : await deps.fillVariables(written, target.connectionId, driver);
    if (filled === undefined) {
      return { ok: false };
    }
    const { statements } = filled;
    if (!(await allowed(statements, driver, policy))) {
      return { ok: false };
    }
    if (!(await keepsTransaction(statements, driver, deps.transactionState?.(documentUri)))) {
      return { ok: false };
    }
    deps.showResults(documentUri);
    const outcome = await deps.runner.run({
      documentUri,
      target,
      statements,
      manualCommit: deps.isManual?.(documentUri) === true,
      ...(replace === undefined ? {} : { replace }),
    });
    report(outcome, deps.logger);
    return sqlTextOutcome(outcome.results, outcome.cancelled);
  };
}

/** A range the CodeLens passes along, as plain numbers so it survives commands. */
export interface RunRangeArgs {
  readonly documentUri: string;
  readonly start: number;
  readonly end: number;
}

export function runCommandHandlers(
  deps: RunQueryDeps,
): Record<RunCommandName, (args?: unknown) => unknown> {
  const run = async (written: readonly SqlStatement[]): Promise<RunOutcome | undefined> => {
    const editor = sqlEditor();
    if (editor === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
      );
      return undefined;
    }
    if (written.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to run'));
      return undefined;
    }
    const documentUri = editor.document.uri.toString();
    const target = await resolveTarget(deps, documentUri);
    if (target === undefined) {
      return undefined;
    }
    const policy = policyOf(deps.store.get(target.connectionId));
    const driver = driverOf(deps, documentUri);
    const filled =
      deps.fillVariables === undefined
        ? { statements: written, substitutions: new Map<number, Substitution>() }
        : await deps.fillVariables(written, target.connectionId, driver);
    if (filled === undefined) {
      return undefined;
    }
    // Safe mode and the run see the values; the markers go back to the written text.
    const { statements } = filled;
    if (!(await allowed(statements, driver, policy))) {
      return undefined;
    }
    if (!(await keepsTransaction(statements, driver, deps.transactionState?.(documentUri)))) {
      return undefined;
    }
    // The panel opens before the run, so a slow query shows "Running…" at once.
    deps.showResults(documentUri);
    const outcome = await deps.runner.run({
      documentUri,
      target,
      statements,
      manualCommit: deps.isManual?.(documentUri) === true,
    });
    deps.diagnostics?.show(
      documentUri,
      inDocument(outcome.results, written, filled.substitutions),
      driverOf(deps, documentUri),
    );
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
function dangerLabel(danger: Danger): string {
  switch (danger) {
    case 'delete-without-where':
      return vscode.l10n.t('DELETE without WHERE');
    case 'update-without-where':
      return vscode.l10n.t('UPDATE without WHERE');
    case 'drop':
      return vscode.l10n.t('DROP');
    case 'truncate':
      return vscode.l10n.t('TRUNCATE');
  }
}

/** The risky statements as lines for the dialog: what is wrong, then the statement. */
function riskLines(risky: readonly RiskyStatement[]): string {
  const shown = risky
    .slice(0, 5)
    .map(
      ({ statement, dangers }) =>
        `• ${dangers.map(dangerLabel).join(', ')}: ${summaryLine(statement.text, 70)}`,
    );
  if (risky.length > shown.length) {
    shown.push(vscode.l10n.t('…and {0} more', risky.length - shown.length));
  }
  return shown.join('\n');
}

/** The changing statements as lines for the dialog, with what safe mode thinks of them. */
function changeLines(changes: readonly SqlStatement[], risky: readonly RiskyStatement[]): string {
  const shown = changes.slice(0, 5).map((statement) => {
    const dangers = risky.find((entry) => entry.statement.start === statement.start)?.dangers;
    const marks = dangers === undefined ? '' : `${dangers.map(dangerLabel).join(', ')}: `;
    return `• ${marks}${summaryLine(statement.text, 70)}`;
  });
  if (changes.length > shown.length) {
    shown.push(vscode.l10n.t('…and {0} more', changes.length - shown.length));
  }
  return shown.join('\n');
}

/**
 * Asks before a run that changes production, and refuses one that would change a
 * read-only connection; then safe mode asks before statements that can destroy data,
 * or refuses them. A production question already covers safe mode's one, so the
 * user is asked once. Returns false when the run must not happen.
 */
async function allowed(
  statements: readonly SqlStatement[],
  driver: DriverId | undefined,
  policy: WritePolicy,
): Promise<boolean> {
  const mode = readSafeMode();
  const risky = riskyStatements(statements, driver, mode);
  const verdict = runVerdict(policy, statements, driver);
  if (verdict.kind === 'refuse') {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('"{0}" is read-only, so this run was stopped.', policy.name),
      {
        modal: true,
        detail: vscode.l10n.t(
          'These statements would change it:\n{0}',
          changeLines(verdict.changes, risky),
        ),
      },
    );
    return false;
  }
  if (verdict.kind === 'confirm' && !(mode === 'block' && risky.length > 0)) {
    const run = vscode.l10n.t('Run on Production');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('This changes the production database "{0}". Run it?', policy.name),
      { modal: true, detail: changeLines(verdict.changes, risky) },
      run,
    );
    return choice === run;
  }
  if (risky.length === 0) {
    return true;
  }
  if (mode === 'block') {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Safe mode blocked this run (datanest.safeMode):\n{0}', riskLines(risky)),
      { modal: true },
    );
    return false;
  }
  const run = vscode.l10n.t('Run anyway');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('This can change or delete a lot of data. Run it?'),
    { modal: true, detail: riskLines(risky) },
    run,
  );
  return choice === run;
}

/**
 * MySQL commits an open transaction before DDL and a few other statements, silently;
 * with a transaction open the user is asked first, since its changes then cannot be
 * rolled back. Returns false when the run must not happen.
 */
async function keepsTransaction(
  statements: readonly SqlStatement[],
  driver: DriverId | undefined,
  state: TransactionState | undefined,
): Promise<boolean> {
  if (state !== 'open') {
    return true;
  }
  const committing = statements.find((statement) => commitsImplicitly(statement.text, driver));
  if (committing === undefined) {
    return true;
  }
  const run = vscode.l10n.t('Commit and Run');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('MySQL commits the open transaction before this statement. Run it?'),
    {
      modal: true,
      detail: vscode.l10n.t(
        '{0}\n\nThe changes made so far are saved for good and cannot be rolled back.',
        summaryLine(committing.text, 70),
      ),
    },
    run,
  );
  return choice === run;
}

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
    if (document.languageId !== SQL_LANGUAGE_ID || this.deps.codeLens?.() === false) {
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

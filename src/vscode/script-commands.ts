// "Run SQL File…" (V5.1): which file, on which connection, what to do on errors,
// then the run itself under a cancellable progress notification and its report.

import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ConnectionManager, SessionTarget } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { formatDuration } from '../services/history-format';
import type { ScriptReport, ScriptRunner } from '../services/script-runner';
import { readTextChunks } from '../services/text-file';
import { changeVerdict, policyOf } from '../services/write-policy';
import { formatSize } from '../shared/byte-size';
import { pickConnection, pickDatabase } from './connection-pick';
import type { DocumentBindings } from './editor/document-bindings';
import { reasonOf, scriptReportText, type ScriptReportTexts } from './script-report';
import { connectionIdOf, isTreeNode, scopeOf } from './tree/nodes';

export interface ScriptCommandDeps {
  readonly store: ConnectionStore;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect'>;
  readonly runner: ScriptRunner;
  readonly bindings: DocumentBindings;
  /** Structure may have changed: forget cached metadata and redraw the tree. */
  readonly refresh: (connectionId: string) => void;
  readonly logger: Logger;
}

/** The progress notification is updated at most this often. */
const PROGRESS_INTERVAL_MS = 250;

export function scriptCommandHandlers(deps: ScriptCommandDeps): {
  runFile: (target?: unknown) => Promise<void>;
} {
  const runFile = async (target?: unknown): Promise<void> => {
    const file = target instanceof vscode.Uri ? target : await askForFile();
    if (file === undefined) {
      return;
    }
    if (file.scheme !== 'file') {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Only files on disk can be run: save the file first'),
      );
      return;
    }
    const where = await targetOf(deps, target, file);
    if (where === undefined) {
      return;
    }
    const config = deps.store.get(where.connectionId);
    const policy = policyOf(config);
    if (changeVerdict(policy) === 'refuse') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('"{0}" is read-only: SQL files cannot run on it.', policy.name),
      );
      return;
    }
    const name = basename(file.fsPath);
    const size = (await vscode.workspace.fs.stat(file)).size;
    const label = targetLabel(config?.name ?? where.connectionId, where.database);
    const continueOnError = await askHowToRun(name, size, label, policy.production);
    if (continueOnError === undefined) {
      return;
    }
    deps.logger.info(`Running ${file.fsPath} on ${label}`);
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Running "{0}"', name),
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          abort.abort();
        });
        let shownPercent = 0;
        let shownAt = 0;
        try {
          return await deps.runner.run({
            target: where,
            chunks: readTextChunks(file.fsPath),
            continueOnError,
            signal: abort.signal,
            onProgress: (state) => {
              const now = Date.now();
              if (now - shownAt < PROGRESS_INTERVAL_MS) {
                return;
              }
              shownAt = now;
              const percent = size === 0 ? 100 : Math.min(100, (state.bytes / size) * 100);
              progress.report({
                increment: percent - shownPercent,
                message: vscode.l10n.t(
                  '{0}% · {1} statements · {2} failed',
                  Math.floor(percent),
                  state.statements,
                  state.failed,
                ),
              });
              shownPercent = percent;
            },
          });
        } finally {
          subscription.dispose();
        }
      },
    );
    deps.refresh(where.connectionId);
    await showOutcome(report, name, label);
  };

  return { runFile };
}

async function askForFile(): Promise<vscode.Uri | undefined> {
  const chosen = await vscode.window.showOpenDialog({
    title: vscode.l10n.t('Run SQL File'),
    canSelectMany: false,
    filters: { SQL: ['sql'], [vscode.l10n.t('All Files')]: ['*'] },
  });
  return chosen?.[0];
}

/**
 * From the tree: the clicked connection and database. From a file: the connection
 * its editor is bound to, if it is open in one. Otherwise the user picks.
 */
async function targetOf(
  deps: ScriptCommandDeps,
  target: unknown,
  file: vscode.Uri,
): Promise<SessionTarget | undefined> {
  if (isTreeNode(target)) {
    const connectionId = connectionIdOf(target);
    if (connectionId === undefined) {
      return undefined;
    }
    const { database } = scopeOf(target);
    return database === undefined ? { connectionId } : { connectionId, database };
  }
  const bound = deps.bindings.get(file.toString());
  if (bound !== undefined) {
    return bound;
  }
  const connectionId = await pickConnection(
    deps.store,
    vscode.l10n.t('Pick the connection to run the file on'),
  );
  if (connectionId === undefined) {
    return undefined;
  }
  const database = await pickDatabase(deps.manager, connectionId);
  return database === undefined ? { connectionId } : { connectionId, database };
}

function targetLabel(connection: string, database: string | undefined): string {
  return database === undefined ? connection : `${connection} / ${database}`;
}

/** True to keep going after a failed statement; undefined when the user backs out. */
async function askHowToRun(
  name: string,
  size: number,
  label: string,
  production: boolean,
): Promise<boolean | undefined> {
  const stop = vscode.l10n.t('Stop at the First Error');
  const goOn = vscode.l10n.t('Continue on Errors');
  const question = vscode.l10n.t('Run "{0}" ({1}) on "{2}"?', name, formatSize(size), label);
  const choice = await vscode.window.showWarningMessage(
    production ? vscode.l10n.t('PRODUCTION "{0}": {1}', label, question) : question,
    {
      modal: true,
      detail: vscode.l10n.t(
        'Statements run one by one while the file is read, on a connection of their own. What should happen when one fails?',
      ),
    },
    stop,
    goOn,
  );
  return choice === undefined ? undefined : choice === goOn;
}

async function showOutcome(report: ScriptReport, name: string, label: string): Promise<void> {
  const texts = reportTexts();
  const showReport = vscode.l10n.t('Show Report');
  const needsReport = report.failedCount > 0 || report.skipped.length > 0 || report.rolledBack;
  const buttons = needsReport ? [showReport] : [];
  const duration = formatDuration(report.durationMs);
  let choice: string | undefined;
  if (report.outcome === 'stopped' && report.stoppedAt !== undefined) {
    choice = await vscode.window.showErrorMessage(
      vscode.l10n.t(
        '"{0}" stopped at line {1}: {2}',
        name,
        report.stoppedAt.line,
        reasonOf(report.stoppedAt, texts),
      ),
      ...buttons,
    );
  } else if (report.outcome === 'cancelled') {
    choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('"{0}" was cancelled after {1} statements', name, report.statements),
      ...buttons,
    );
  } else if (needsReport) {
    choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        '"{0}": {1} statements in {2}, {3} failed',
        name,
        report.statements,
        duration,
        report.failedCount,
      ),
      ...buttons,
    );
  } else {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('"{0}": {1} statements in {2}', name, report.statements, duration),
    );
  }
  if (choice === showReport) {
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: scriptReportText(report, name, label, texts),
    });
    await vscode.window.showTextDocument(document);
  }
}

function reportTexts(): ScriptReportTexts {
  return {
    title: (file) => vscode.l10n.t('Running "{0}"', file),
    target: (target) => vscode.l10n.t('Connection: {0}', target),
    finished: vscode.l10n.t('Finished: the whole file was read'),
    stopped: (line) => vscode.l10n.t('Stopped at line {0}', line),
    cancelled: vscode.l10n.t('Cancelled'),
    totals: (statements, failed, rows) =>
      vscode.l10n.t('{0} statements, {1} failed, {2} rows affected', statements, failed, rows),
    read: (size, duration) => vscode.l10n.t('{0} read in {1}', size, duration),
    rolledBack: vscode.l10n.t(
      'The file ended inside a transaction that was never committed; it was rolled back.',
    ),
    failures: vscode.l10n.t('Failed statements'),
    more: (count) => vscode.l10n.t('…and {0} more', count),
    skipped: vscode.l10n.t('Skipped psql commands'),
    line: (line) => vscode.l10n.t('Line {0}', line),
    copyFromStdin: vscode.l10n.t(
      'COPY … FROM stdin is not supported: its rows were skipped. Make the dump with pg_dump --inserts.',
    ),
    psqlCommand: vscode.l10n.t(
      'psql commands do not run on the server; open the file on the right database instead.',
    ),
  };
}

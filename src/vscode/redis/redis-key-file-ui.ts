// The editor side of "Export Keys…" and "Restore Keys…" (V13.9): file dialogs, the
// question about keys that exist, the progress and the reports.

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { formatCount } from '../../core/number-format';
import { fileNameFor } from '../../services/cell-file';
import { FileSink } from '../../services/file-sink';
import type { ExportReport, RestorePolicy, RestoreReport } from '../../services/redis/key-files';
import { readTextChunks } from '../../services/text-file';
import type {
  KeyFileSink,
  KeyFileTexts,
  KeyFileUi,
  RedisKeyFileDeps,
} from './redis-key-file-commands';

function startFolder(): vscode.Uri {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
}

async function openReport(title: string, lines: readonly string[]): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [`# ${title}`, '', ...lines, ''].join('\n'),
  });
  await vscode.window.showTextDocument(document);
}

const keyFileTexts: KeyFileTexts = {
  readOnly: vscode.l10n.t('The connection is read-only: nothing may change'),
  exportTitle: (what) => vscode.l10n.t('Exporting keys of {0}', what),
  restoreTitle: (what) => vscode.l10n.t('Restoring keys into {0}', what),
  keysDone: (count) => vscode.l10n.t('{0} keys', formatCount(count, vscode.env.language)),
  productionQuestion: (connection) =>
    vscode.l10n.t(
      'PRODUCTION "{0}": {1}',
      connection,
      vscode.l10n.t('Write the keys of the file into this database?'),
    ),
  restoreAction: vscode.l10n.t('Restore'),
};

type PolicyChoice = vscode.QuickPickItem & { readonly policy: RestorePolicy['kind'] };

const keyFileUi: KeyFileUi = {
  pickSaveFile: async (defaultName) =>
    (
      await vscode.window.showSaveDialog({
        title: vscode.l10n.t('Export Keys'),
        defaultUri: vscode.Uri.joinPath(startFolder(), defaultName),
        filters: { [vscode.l10n.t('Redis keys, one JSON record per line')]: ['jsonl', 'ndjson'] },
      })
    )?.fsPath,

  pickOpenFile: async () =>
    (
      await vscode.window.showOpenDialog({
        title: vscode.l10n.t('Restore Keys'),
        defaultUri: startFolder(),
        canSelectMany: false,
        filters: {
          [vscode.l10n.t('Redis keys, one JSON record per line')]: ['jsonl', 'ndjson'],
          [vscode.l10n.t('All files')]: ['*'],
        },
      })
    )?.[0]?.fsPath,

  askPolicy: async (): Promise<RestorePolicy | undefined> => {
    const choices: PolicyChoice[] = [
      {
        label: `$(shield) ${vscode.l10n.t('Skip keys that exist')}`,
        description: vscode.l10n.t('they stay as they are'),
        policy: 'skip',
      },
      {
        label: `$(replace-all) ${vscode.l10n.t('Overwrite keys that exist')}`,
        description: vscode.l10n.t('the key of the file replaces them'),
        policy: 'overwrite',
      },
      {
        label: `$(symbol-namespace) ${vscode.l10n.t('Restore under a prefix')}`,
        description: vscode.l10n.t('nothing that exists is touched'),
        policy: 'prefix',
      },
    ];
    const chosen = await vscode.window.showQuickPick(choices, {
      title: vscode.l10n.t('Restore Keys'),
      placeHolder: vscode.l10n.t('What to do with a key that already exists?'),
    });
    if (chosen === undefined) {
      return undefined;
    }
    if (chosen.policy === 'skip') {
      return { kind: 'skip' };
    }
    if (chosen.policy === 'overwrite') {
      return { kind: 'overwrite' };
    }
    const prefix = await vscode.window.showInputBox({
      title: vscode.l10n.t('Restore Keys'),
      prompt: vscode.l10n.t('Every key of the file gets this at the start of its name'),
      value: 'restored:',
      validateInput: (text) => (text === '' ? vscode.l10n.t('A prefix is needed') : undefined),
    });
    return prefix === undefined ? undefined : { kind: 'prefix', prefix };
  },

  confirm: async (message, detail, action) =>
    (await vscode.window.showWarningMessage(
      message,
      { modal: true, ...(detail === undefined ? {} : { detail }) },
      action,
    )) === action,

  withProgress: async (title, task) =>
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) =>
        await task(
          {
            get aborted() {
              return token.isCancellationRequested;
            },
          },
          (text) => {
            progress.report({ message: text });
          },
        ),
    ),

  showExported: (report: ExportReport, path: string) => {
    const language = vscode.env.language;
    if (report.cancelled) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Export cancelled: nothing was written'),
      );
      return;
    }
    const summary = vscode.l10n.t(
      'Exported {0} keys to {1}',
      formatCount(report.keys, language),
      path,
    );
    if (report.skipped.length === 0) {
      void vscode.window.showInformationMessage(summary);
      return;
    }
    void (async () => {
      const show = vscode.l10n.t('Show Report');
      const tail = vscode.l10n.t('Left out: {0}.', formatCount(report.skipped.length, language));
      if ((await vscode.window.showWarningMessage(`${summary}. ${tail}`, show)) === show) {
        await openReport(
          summary,
          report.skipped.map((item) => `- \`${item.key}\`: ${item.reason}`),
        );
      }
    })();
  },

  showRestored: (report: RestoreReport, place: string) => {
    const language = vscode.env.language;
    const summary = vscode.l10n.t(
      'Restored {0} keys into {1}',
      formatCount(report.restored, language),
      place,
    );
    const tail = [
      report.cancelled ? vscode.l10n.t('Cancelled') : '',
      report.skipped === 0
        ? ''
        : vscode.l10n.t('Left as they were: {0}', formatCount(report.skipped, language)),
      report.failed === 0
        ? ''
        : vscode.l10n.t('Refused: {0}', formatCount(report.failed, language)),
    ].filter((part) => part !== '');
    const text = tail.length === 0 ? `${summary}.` : `${summary}. ${tail.join('. ')}.`;
    if (report.problems.length === 0) {
      void vscode.window.showInformationMessage(text);
      return;
    }
    void (async () => {
      const show = vscode.l10n.t('Show Report');
      if ((await vscode.window.showWarningMessage(text, show)) === show) {
        const more =
          report.failed > report.problems.length
            ? ['', vscode.l10n.t('…and {0} more', report.failed - report.problems.length)]
            : [];
        await openReport(summary, [
          ...report.problems.map(
            (problem) => `- ${vscode.l10n.t('Line {0}: {1}', problem.line, problem.message)}`,
          ),
          ...more,
        ]);
      }
    })();
  },
};

/** The parts of the file commands that talk to the editor and the disk. */
export const keyFileEditorDeps: Pick<
  RedisKeyFileDeps,
  'ui' | 'texts' | 'openSink' | 'readChunks' | 'fileNameFor'
> = {
  ui: keyFileUi,
  texts: keyFileTexts,
  openSink: async (path): Promise<KeyFileSink> => await FileSink.create(path),
  readChunks: (path) => readTextChunks(path),
  fileNameFor,
};

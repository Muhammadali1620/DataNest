// The editor side of "Export Index…", "Import Documents…" and "Import as New Index…"
// (V13.11): file dialogs, the questions about ids and refused documents, the progress and
// the reports.

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { formatCount } from '../../core/number-format';
import { fileNameFor } from '../../services/cell-file';
import { FileSink } from '../../services/file-sink';
import type { IdMode, IndexFileFormat, WriteOp } from '../../services/elasticsearch/index-files';
import type { ImportMode, ImportReport } from '../../services/mongodb/collection-files';
import { readTextChunks } from '../../services/text-file';
import type {
  ImportOptions,
  IndexFileDeps,
  IndexFileSink,
  IndexFileTexts,
  IndexFileUi,
} from './index-file-commands';

function startFolder(): vscode.Uri {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
}

const indexFileTexts: IndexFileTexts = {
  readOnly: vscode.l10n.t('The connection is read-only: nothing may change'),
  noElastic: vscode.l10n.t('There is no Elasticsearch connection yet'),
  exportTitle: (index) => vscode.l10n.t('Exporting {0}', index),
  importTitle: (index) => vscode.l10n.t('Importing into {0}', index),
  importNewTitle: vscode.l10n.t('Import as New Index'),
  documentsDone: (count) => vscode.l10n.t('{0} documents', formatCount(count, vscode.env.language)),
  productionQuestion: (connection, index) =>
    vscode.l10n.t(
      'PRODUCTION "{0}": {1}',
      connection,
      vscode.l10n.t('Add the documents of the file to {0}?', index),
    ),
  importAction: vscode.l10n.t('Import'),
};

type FormatChoice = vscode.QuickPickItem & { readonly format: IndexFileFormat };
type IdChoice = vscode.QuickPickItem & { readonly ids: IdMode; readonly op: WriteOp };
type ModeChoice = vscode.QuickPickItem & { readonly mode: ImportMode };

async function openReport(title: string, lines: readonly string[]): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [`# ${title}`, '', ...lines, ''].join('\n'),
  });
  await vscode.window.showTextDocument(document);
}

const indexFileUi: IndexFileUi = {
  pickFormat: async (index) =>
    (
      await vscode.window.showQuickPick<FormatChoice>(
        [
          {
            label: `$(database) ${vscode.l10n.t('Documents with mappings and settings')}`,
            description: vscode.l10n.t('loads into a new index just like this one'),
            format: 'documents-with-mapping',
          },
          {
            label: `$(json) ${vscode.l10n.t('Documents only')}`,
            description: vscode.l10n.t('one {"_id", "_source"} per line'),
            format: 'documents',
          },
          {
            label: `$(terminal) ${vscode.l10n.t('Bulk format')}`,
            description: vscode.l10n.t('action and document lines, for curl and _bulk'),
            format: 'bulk',
          },
        ],
        { title: vscode.l10n.t('Export the Index "{0}"', index) },
      )
    )?.format,

  pickSaveFile: async (defaultName, index) =>
    (
      await vscode.window.showSaveDialog({
        title: vscode.l10n.t('Export the Index "{0}"', index),
        defaultUri: vscode.Uri.joinPath(startFolder(), defaultName),
        filters: { [vscode.l10n.t('JSON, one document per line')]: ['ndjson', 'jsonl', 'json'] },
      })
    )?.fsPath,

  pickOpenFile: async (title) =>
    (
      await vscode.window.showOpenDialog({
        title,
        defaultUri: startFolder(),
        canSelectMany: false,
        filters: {
          [vscode.l10n.t('JSON, one document per line, or a JSON array')]: [
            'json',
            'jsonl',
            'ndjson',
          ],
          [vscode.l10n.t('All files')]: ['*'],
        },
      })
    )?.[0]?.fsPath,

  askImportOptions: async (title): Promise<ImportOptions | undefined> => {
    const ids = await vscode.window.showQuickPick<IdChoice>(
      [
        {
          label: `$(replace-all) ${vscode.l10n.t('Keep the ids, replace documents that exist')}`,
          description: vscode.l10n.t('a document with a known id is overwritten'),
          ids: 'keep',
          op: 'index',
        },
        {
          label: `$(shield) ${vscode.l10n.t('Keep the ids, leave documents that exist')}`,
          description: vscode.l10n.t('a document with a known id is refused and listed'),
          ids: 'keep',
          op: 'create',
        },
        {
          label: `$(add) ${vscode.l10n.t('Make up new ids')}`,
          description: vscode.l10n.t('every document is added; the ids of the file are dropped'),
          ids: 'generate',
          op: 'create',
        },
      ],
      { title, placeHolder: vscode.l10n.t('What happens to the ids of the documents?') },
    );
    if (ids === undefined) {
      return undefined;
    }
    const mode = await vscode.window.showQuickPick<ModeChoice>(
      [
        {
          label: vscode.l10n.t('Stop at the first refused document'),
          description: vscode.l10n.t('the documents before it stay'),
          mode: 'stop',
        },
        {
          label: vscode.l10n.t('Skip refused documents'),
          description: vscode.l10n.t('and list them in the report'),
          mode: 'skip',
        },
      ],
      { title, placeHolder: vscode.l10n.t('What happens to a refused document?') },
    );
    return mode === undefined ? undefined : { mode: mode.mode, ids: ids.ids, op: ids.op };
  },

  askIndexName: async (suggested, check) =>
    await vscode.window.showInputBox({
      title: vscode.l10n.t('Import as New Index'),
      prompt: vscode.l10n.t('The name of the new index, in lowercase'),
      value: suggested,
      ignoreFocusOut: true,
      validateInput: check,
    }),

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

  showExported: (result, path) => {
    void vscode.window.showInformationMessage(
      result.cancelled
        ? vscode.l10n.t('Export cancelled: nothing was written')
        : vscode.l10n.t(
            'Exported {0} documents to {1}',
            formatCount(result.documents, vscode.env.language),
            path,
          ),
    );
  },

  showImported: (report: ImportReport, index: string) => {
    const language = vscode.env.language;
    const summary = vscode.l10n.t(
      'Added {0} documents to {1}',
      formatCount(report.inserted, language),
      index,
    );
    const tail = report.cancelled
      ? ` ${vscode.l10n.t('Cancelled')}.`
      : report.refused === 0
        ? ''
        : ` ${vscode.l10n.t('Refused: {0}.', formatCount(report.refused, language))}`;
    if (report.problems.length === 0) {
      void vscode.window.showInformationMessage(`${summary}.${tail}`);
      return;
    }
    void (async () => {
      const show = vscode.l10n.t('Show Report');
      if ((await vscode.window.showWarningMessage(`${summary}.${tail}`, show)) === show) {
        await openReport(summary, [
          ...report.problems.map(
            (problem) => `- ${vscode.l10n.t('Line {0}: {1}', problem.line, problem.message)}`,
          ),
          ...(report.refused > report.problems.length
            ? ['', vscode.l10n.t('…and {0} more', report.refused - report.problems.length)]
            : []),
        ]);
      }
    })();
  },
};

/** The parts of the index file commands that talk to the editor and the disk. */
export const indexFileEditorDeps: Pick<
  IndexFileDeps,
  'ui' | 'texts' | 'openSink' | 'readChunks' | 'fileNameFor'
> = {
  ui: indexFileUi,
  texts: indexFileTexts,
  openSink: async (path): Promise<IndexFileSink> => await FileSink.create(path),
  readChunks: (path) => readTextChunks(path),
  fileNameFor,
};

// "Export Documents…" and "Import Documents…" of a MongoDB collection (V10.2.7): the
// file dialogs, the question of what a refused document does, the production check and
// the report. The work itself is in services/mongodb/collection-files.ts.

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { DbError } from '../../core/errors';
import { formatCount } from '../../core/number-format';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { FileSink } from '../../services/file-sink';
import {
  exportCollection,
  importCollection,
  type ImportMode,
  type ImportReport,
} from '../../services/mongodb/collection-files';
import { fileNameFor } from '../../services/cell-file';
import { readTextChunks } from '../../services/text-file';
import { isTreeNode, type MongoCollectionNode } from '../tree/nodes';
import { mongoTreeSession } from '../tree/mongo-tree';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';

export interface CollectionFileDeps {
  readonly manager: Pick<ConnectionManager, 'acquireMongo'>;
  readonly store: Pick<ConnectionStore, 'get'>;
  readonly tree: RefreshableTree;
}

function collectionOf(target: CommandTarget): MongoCollectionNode | undefined {
  return isTreeNode(target) && target.kind === 'mongoCollection' ? target : undefined;
}

function startFolder(): vscode.Uri {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
}

export function collectionFileCommands(deps: CollectionFileDeps): {
  exportDocuments: (target?: CommandTarget) => Promise<void>;
  importDocuments: (target?: CommandTarget) => Promise<void>;
} {
  const exportDocuments = async (target?: CommandTarget): Promise<void> => {
    const node = collectionOf(target);
    if (node === undefined) {
      return;
    }
    const file = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Export the Documents of "{0}"', node.collection),
      defaultUri: vscode.Uri.joinPath(startFolder(), `${fileNameFor(node.collection)}.json`),
      filters: {
        [vscode.l10n.t('Extended JSON, one document per line')]: ['json', 'jsonl', 'ndjson'],
      },
    });
    if (file === undefined) {
      return;
    }
    const sink = await FileSink.create(file.fsPath);
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Exporting {0}', node.collection),
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          abort.abort();
        });
        try {
          const session = await mongoTreeSession(deps.manager, node.connectionId);
          const result = await exportCollection({
            session,
            database: node.database,
            collection: node.collection,
            sink,
            signal: abort.signal,
            onProgress: (documents) => {
              progress.report({
                message: vscode.l10n.t(
                  '{0} documents',
                  formatCount(documents, vscode.env.language),
                ),
              });
            },
          });
          if (result.cancelled) {
            await sink.discard();
          } else {
            await sink.close();
          }
          return result;
        } catch (error) {
          await sink.discard();
          throw error;
        } finally {
          subscription.dispose();
        }
      },
    );
    void vscode.window.showInformationMessage(
      outcome.cancelled
        ? vscode.l10n.t('Export cancelled: nothing was written')
        : vscode.l10n.t(
            'Exported {0} documents to {1}',
            formatCount(outcome.documents, vscode.env.language),
            file.fsPath,
          ),
    );
  };

  const importDocuments = async (target?: CommandTarget): Promise<void> => {
    const node = collectionOf(target);
    if (node === undefined) {
      return;
    }
    const config = deps.store.get(node.connectionId);
    if (config?.readOnly === true) {
      throw new DbError(
        'permission-denied',
        vscode.l10n.t('The connection is read-only: nothing may change'),
      );
    }
    const [file] =
      (await vscode.window.showOpenDialog({
        title: vscode.l10n.t('Import Documents into "{0}"', node.collection),
        defaultUri: startFolder(),
        canSelectMany: false,
        filters: {
          [vscode.l10n.t('Extended JSON or a JSON array')]: ['json', 'jsonl', 'ndjson'],
          [vscode.l10n.t('All files')]: ['*'],
        },
      })) ?? [];
    if (file === undefined) {
      return;
    }
    const choices: (vscode.QuickPickItem & { readonly mode: ImportMode })[] = [
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
    ];
    const mode = (
      await vscode.window.showQuickPick(choices, {
        title: vscode.l10n.t('Import Documents into "{0}"', node.collection),
      })
    )?.mode;
    if (mode === undefined) {
      return;
    }
    if (config?.production === true) {
      const insert = vscode.l10n.t('Import');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'PRODUCTION "{0}": {1}',
          config.name,
          vscode.l10n.t('Insert the documents of the file into {0}?', node.collection),
        ),
        { modal: true },
        insert,
      );
      if (choice !== insert) {
        return;
      }
    }
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Importing into {0}', node.collection),
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          abort.abort();
        });
        try {
          return await importCollection({
            session: await mongoTreeSession(deps.manager, node.connectionId),
            database: node.database,
            collection: node.collection,
            chunks: readTextChunks(file.fsPath),
            mode,
            signal: abort.signal,
            onProgress: (inserted) => {
              progress.report({
                message: vscode.l10n.t('{0} documents', formatCount(inserted, vscode.env.language)),
              });
            },
          });
        } finally {
          subscription.dispose();
        }
      },
    );
    deps.tree.refresh({ kind: 'connection', connectionId: node.connectionId });
    await showReport(report, node.collection);
  };

  return { exportDocuments, importDocuments };
}

async function showReport(report: ImportReport, collection: string): Promise<void> {
  const language = vscode.env.language;
  const summary = vscode.l10n.t(
    'Inserted {0} documents into {1}',
    formatCount(report.inserted, language),
    collection,
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
  const show = vscode.l10n.t('Show Report');
  const choice = await vscode.window.showWarningMessage(`${summary}.${tail}`, show);
  if (choice !== show) {
    return;
  }
  const lines = [
    `# ${summary}`,
    '',
    ...report.problems.map(
      (problem) => `- ${vscode.l10n.t('Line {0}: {1}', problem.line, problem.message)}`,
    ),
    ...(report.refused > report.problems.length
      ? ['', vscode.l10n.t('…and {0} more', report.refused - report.problems.length)]
      : []),
    '',
  ];
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: lines.join('\n'),
  });
  await vscode.window.showTextDocument(document);
}

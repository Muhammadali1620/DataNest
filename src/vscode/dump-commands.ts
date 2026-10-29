// "Dump to SQL File…" (V5.2): what to dump (tables and views, and the rest of a
// database or schema), structure and/or data, where to — then the dump itself under
// a cancellable progress notification.

import { join } from 'node:path';
import * as vscode from 'vscode';
import { isDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { ObjectScope, TableInfo } from '../core/model/objects';
import { browseSession } from '../services/browse-session';
import type { ConnectionManager, SessionTarget } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { FileSink } from '../services/file-sink';
import { formatDuration } from '../services/history-format';
import type { MetadataCache } from '../services/metadata-cache';
import type { DumpContent, DumpReport, SqlDumper } from '../services/sql-dump';
import { formatSize } from '../shared/byte-size';
import { pickConnection, pickScope } from './connection-pick';
import { dumpFileName, type DumpStart, dumpStartOf } from './tree/dump-target';
import { isTreeNode, type TreeNode } from './tree/nodes';

export interface DumpCommandDeps {
  readonly store: ConnectionStore;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire'>;
  readonly cache: MetadataCache;
  readonly dumper: SqlDumper;
  readonly logger: Logger;
}

/** The progress notification is updated at most this often. */
const PROGRESS_INTERVAL_MS = 250;

interface RelationItem extends vscode.QuickPickItem {
  readonly relation?: TableInfo;
  /** The item that stands for routines, events, sequences and types. */
  readonly rest?: true;
}

export function dumpCommandHandlers(deps: DumpCommandDeps): {
  dump: (target?: unknown, selection?: readonly TreeNode[]) => Promise<void>;
} {
  const dump = async (target?: unknown, selection?: readonly TreeNode[]): Promise<void> => {
    const start = await startOf(deps, target, selection);
    if (start === undefined) {
      return;
    }
    const scope = await scopeOf(deps, start);
    if (scope === undefined) {
      return;
    }
    const metadata = deps.cache.wrap(
      start.connectionId,
      (await browseSession(deps.manager, start.connectionId, scope.database)).metadata,
    );
    const relations = await metadata.listTables(scope);
    const chosen = await pickRelations(relations, start);
    if (chosen === undefined) {
      return;
    }
    const content = await pickContent();
    if (content === undefined) {
      return;
    }
    const dropFirst = content === 'data' ? false : await pickDrop();
    if (dropFirst === undefined) {
      return;
    }
    const config = deps.store.get(start.connectionId);
    const scopeName = scope.schema ?? scope.database ?? config?.name ?? 'dump';
    const fileStem =
      chosen.relations.length === 1 && !chosen.wholeScope
        ? (chosen.relations[0]?.name ?? scopeName)
        : scopeName;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const name = dumpFileName(fileStem, new Date());
    const file = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Dump to SQL File'),
      defaultUri: vscode.Uri.file(folder === undefined ? name : join(folder, name)),
      filters: { SQL: ['sql'] },
    });
    if (file === undefined) {
      return;
    }
    const source = [config?.name ?? start.connectionId, scope.database, scope.schema]
      .filter((part): part is string => part !== undefined)
      .join(' / ');
    const session: SessionTarget =
      scope.database === undefined
        ? { connectionId: start.connectionId }
        : { connectionId: start.connectionId, database: scope.database };
    const sink = await FileSink.create(file.fsPath);
    let report: DumpReport;
    try {
      report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Dumping "{0}"', source),
          cancellable: true,
        },
        async (progress, token) => {
          const abort = new AbortController();
          const subscription = token.onCancellationRequested(() => {
            abort.abort();
          });
          let shownAt = 0;
          try {
            return await deps.dumper.dump({
              target: session,
              scope,
              relations: chosen.relations,
              wholeScope: chosen.wholeScope,
              content,
              dropFirst,
              sink,
              source,
              signal: abort.signal,
              onProgress: (state) => {
                const now = Date.now();
                if (now - shownAt < PROGRESS_INTERVAL_MS) {
                  return;
                }
                shownAt = now;
                progress.report({
                  message: vscode.l10n.t(
                    '{0}: {1} rows · table {2} of {3}',
                    state.table ?? '',
                    state.rows,
                    Math.min(state.tablesDone + 1, state.tablesTotal),
                    state.tablesTotal,
                  ),
                });
              },
            });
          } finally {
            subscription.dispose();
          }
        },
      );
      await sink.close();
    } catch (error) {
      await sink.discard();
      if (isDbError(error) && error.code === 'cancelled') {
        void vscode.window.showInformationMessage(vscode.l10n.t('The dump was cancelled'));
        return;
      }
      throw error;
    }
    deps.logger.info(`Dump of ${source} written to ${file.fsPath}`);
    await showOutcome(report, file, sink.bytes);
  };

  return { dump };
}

async function startOf(
  deps: DumpCommandDeps,
  target: unknown,
  selection: readonly TreeNode[] | undefined,
): Promise<DumpStart | undefined> {
  if (isTreeNode(target)) {
    return dumpStartOf(target, selection);
  }
  const connectionId = await pickConnection(
    deps.store,
    vscode.l10n.t('Pick the connection to dump'),
  );
  return connectionId === undefined
    ? undefined
    : { connectionId, scope: undefined, preselect: undefined, wholeScope: true };
}

/** The scope the start names, or the database (and schema) the user picks now. */
async function scopeOf(deps: DumpCommandDeps, start: DumpStart): Promise<ObjectScope | undefined> {
  return await pickScope(
    deps.manager,
    start.connectionId,
    start.scope,
    vscode.l10n.t('Pick the schema to dump'),
  );
}

async function pickRelations(
  relations: readonly TableInfo[],
  start: DumpStart,
): Promise<{ relations: TableInfo[]; wholeScope: boolean } | undefined> {
  const ticked = (relation: TableInfo): boolean =>
    start.preselect === undefined
      ? start.only === undefined || relation.kind === start.only
      : start.preselect.includes(relation.name);
  const items: RelationItem[] = relations.map((relation) => ({
    label: `$(${relation.kind === 'view' ? 'eye' : 'table'}) ${relation.name}`,
    description:
      relation.kind === 'view'
        ? relation.materialized === true
          ? vscode.l10n.t('materialized view')
          : vscode.l10n.t('view')
        : undefined,
    picked: ticked(relation),
    relation,
  }));
  if (start.wholeScope) {
    items.unshift({
      label: vscode.l10n.t('$(symbol-method) Functions, procedures, events, sequences and types'),
      picked: true,
      rest: true,
    });
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is nothing here to dump'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Dump to SQL File'),
    placeHolder: vscode.l10n.t('Pick what goes into the dump; triggers come with their tables'),
    canPickMany: true,
    matchOnDescription: true,
  });
  if (picked === undefined || picked.length === 0) {
    return undefined;
  }
  return {
    relations: picked.flatMap((item) => (item.relation === undefined ? [] : [item.relation])),
    wholeScope: picked.some((item) => item.rest === true),
  };
}

async function pickContent(): Promise<DumpContent | undefined> {
  const items: (vscode.QuickPickItem & { content: DumpContent })[] = [
    { label: vscode.l10n.t('Structure and data'), content: 'all' },
    { label: vscode.l10n.t('Structure only'), content: 'structure' },
    {
      label: vscode.l10n.t('Data only'),
      description: vscode.l10n.t('INSERT statements for existing tables'),
      content: 'data',
    },
  ];
  return (
    await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Dump to SQL File'),
      placeHolder: vscode.l10n.t('What should the dump hold?'),
    })
  )?.content;
}

async function pickDrop(): Promise<boolean | undefined> {
  const items: (vscode.QuickPickItem & { drop: boolean })[] = [
    {
      label: vscode.l10n.t('Replace what exists'),
      description: vscode.l10n.t('DROP … IF EXISTS before each CREATE'),
      drop: true,
    },
    {
      label: vscode.l10n.t('Only create'),
      description: vscode.l10n.t('for an empty database'),
      drop: false,
    },
  ];
  return (
    await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Dump to SQL File'),
      placeHolder: vscode.l10n.t('When the script runs where the objects already exist'),
    })
  )?.drop;
}

async function showOutcome(report: DumpReport, file: vscode.Uri, bytes: number): Promise<void> {
  const open = vscode.l10n.t('Open');
  const reveal = vscode.l10n.t('Show in Folder');
  const summary = vscode.l10n.t(
    'Dump saved: {0} tables, {1} views, {2} rows, {3} in {4}',
    report.tables,
    report.views,
    report.rows,
    formatSize(bytes),
    formatDuration(report.durationMs),
  );
  const choice =
    report.skipped.length === 0
      ? await vscode.window.showInformationMessage(summary, open, reveal)
      : await vscode.window.showWarningMessage(
          `${summary}. ${vscode.l10n.t(
            'Left out, the server does not show their definition to this user: {0}',
            report.skipped.map((skip) => skip.name).join(', '),
          )}`,
          open,
          reveal,
        );
  if (choice === open) {
    await vscode.window.showTextDocument(file);
  } else if (choice === reveal) {
    await vscode.commands.executeCommand('revealFileInOS', file);
  }
}

// "Copy to Another Connection…" (V5.6): which tables, where to, structure and/or
// data, what to do with tables already there — then the copy with progress and a
// report of what was translated or left out.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ObjectScope } from '../core/model/objects';
import { browseSession } from '../services/browse-session';
import type { ConnectionManager, SessionTarget } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { formatDuration } from '../services/history-format';
import type { MetadataCache } from '../services/metadata-cache';
import type {
  ExistingTable,
  TableTransferService,
  TransferContent,
  TransferNote,
  TransferReport,
} from '../services/transfer/table-transfer';
import { changeVerdict, policyOf } from '../services/write-policy';
import {
  copyName,
  duplicateNameProblem,
  tableNameLimit,
} from '../services/transfer/duplicate-name';
import { pickConnection, pickScope } from './connection-pick';
import { dumpStartOf } from './tree/dump-target';
import { isTreeNode, type TreeNode } from './tree/nodes';
import { transferReportText, type TransferReportTexts, worthReading } from './transfer-report';

export interface TransferCommandDeps {
  readonly store: ConnectionStore;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire'>;
  readonly cache: MetadataCache;
  readonly service: TableTransferService;
  /** The target's structure changed: forget its cached metadata and redraw the tree. */
  readonly refresh: (connectionId: string) => void;
  readonly logger: Logger;
}

const PROGRESS_INTERVAL_MS = 250;

function label(store: ConnectionStore, connectionId: string, scope: ObjectScope): string {
  return [store.get(connectionId)?.name ?? connectionId, scope.database, scope.schema]
    .filter((part): part is string => part !== undefined)
    .join(' / ');
}

function targetOf(connectionId: string, scope: ObjectScope): SessionTarget {
  return scope.database === undefined
    ? { connectionId }
    : { connectionId, database: scope.database };
}

export function tableTransferCommandHandlers(deps: TransferCommandDeps): {
  transfer: (target?: unknown, selection?: readonly TreeNode[]) => Promise<void>;
  duplicate: (target?: unknown) => Promise<void>;
} {
  /** "Duplicate Table…" (V10.2.3): a copy beside the table, under a new name. */
  const duplicate = async (target?: unknown): Promise<void> => {
    if (!isTreeNode(target) || target.kind !== 'table' || target.tableKind !== 'table') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a table in the DataNest view first'),
      );
      return;
    }
    const { connectionId, scope, name } = target;
    const config = deps.store.get(connectionId);
    if (config === undefined) {
      return;
    }
    const policy = policyOf(config);
    const verdict = changeVerdict(policy);
    if (verdict === 'refuse') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('"{0}" is read-only: nothing can be copied into it.', policy.name),
      );
      return;
    }
    const metadata = deps.cache.wrap(
      connectionId,
      (await browseSession(deps.manager, connectionId, scope.database)).metadata,
    );
    const existing = (await metadata.listTables(scope)).map((table) => table.name);
    const limit = tableNameLimit(config.driver);
    const copy = await vscode.window.showInputBox({
      title: vscode.l10n.t('Duplicate Table "{0}"', name),
      prompt: vscode.l10n.t('The name of the copy, beside the table'),
      value: copyName(name, existing, limit),
      validateInput: (value) => {
        switch (duplicateNameProblem(value, existing, limit)) {
          case 'empty':
            return vscode.l10n.t('Give the copy a name');
          case 'too-long':
            return vscode.l10n.t('A name can be at most {0} characters here', limit);
          case 'taken':
            return vscode.l10n.t('There is already a table or view of this name');
          case undefined:
            return undefined;
        }
      },
    });
    if (copy === undefined) {
      return;
    }
    const content = (
      await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t('Structure and data'), content: 'all' as const },
          { label: vscode.l10n.t('Structure only'), content: 'structure' as const },
        ],
        { title: vscode.l10n.t('Duplicate Table "{0}"', name), placeHolder: copy.trim() },
      )
    )?.content;
    if (content === undefined) {
      return;
    }
    if (verdict === 'confirm') {
      const create = vscode.l10n.t('Create');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'PRODUCTION "{0}": {1}',
          policy.name,
          vscode.l10n.t('Create the table {0}?', copy.trim()),
        ),
        { modal: true },
        create,
      );
      if (choice !== create) {
        return;
      }
    }
    const where = label(deps.store, connectionId, scope);
    const end = { target: targetOf(connectionId, scope), scope };
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Copying {0} to {1}', name, copy.trim()),
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          abort.abort();
        });
        try {
          return await deps.service.transfer({
            source: end,
            destination: end,
            tables: [name],
            renames: new Map([[name, copy.trim()]]),
            content,
            existing: 'skip',
            signal: abort.signal,
          });
        } finally {
          subscription.dispose();
        }
      },
    );
    deps.refresh(connectionId);
    await showOutcome(report, `${where} / ${name}`, `${where} / ${copy.trim()}`);
  };

  const transfer = async (target?: unknown, selection?: readonly TreeNode[]): Promise<void> => {
    const start = isTreeNode(target)
      ? dumpStartOf(target, selection)
      : await (async () => {
          const connectionId = await pickConnection(
            deps.store,
            vscode.l10n.t('Pick the connection to copy from'),
          );
          return connectionId === undefined
            ? undefined
            : { connectionId, scope: undefined, preselect: undefined, wholeScope: true };
        })();
    if (start === undefined) {
      return;
    }
    const schemaPrompt = vscode.l10n.t('Pick the schema');
    const fromScope = await pickScope(deps.manager, start.connectionId, start.scope, schemaPrompt);
    if (fromScope === undefined) {
      return;
    }
    const metadata = deps.cache.wrap(
      start.connectionId,
      (await browseSession(deps.manager, start.connectionId, fromScope.database)).metadata,
    );
    const tables = (await metadata.listTables(fromScope)).filter((table) => table.kind === 'table');
    if (tables.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There are no tables here to copy'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tables.map((table) => ({
        label: `$(table) ${table.name}`,
        name: table.name,
        picked: start.preselect === undefined || start.preselect.includes(table.name),
      })),
      {
        title: vscode.l10n.t('Copy to Another Connection'),
        placeHolder: vscode.l10n.t('Pick the tables to copy'),
        canPickMany: true,
      },
    );
    if (picked === undefined || picked.length === 0) {
      return;
    }
    const toConnection = await pickConnection(
      deps.store,
      vscode.l10n.t('Pick the connection to copy to'),
    );
    if (toConnection === undefined) {
      return;
    }
    const toScope = await pickScope(deps.manager, toConnection, undefined, schemaPrompt);
    if (toScope === undefined) {
      return;
    }
    if (
      toConnection === start.connectionId &&
      toScope.database === fromScope.database &&
      toScope.schema === fromScope.schema
    ) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('The tables are already there: pick another database or schema'),
      );
      return;
    }
    const content = await pickContent();
    if (content === undefined) {
      return;
    }
    const existing = await pickExisting(content);
    if (existing === undefined) {
      return;
    }
    const from = label(deps.store, start.connectionId, fromScope);
    const to = label(deps.store, toConnection, toScope);
    if (!(await confirm(deps, toConnection, picked.length, from, to))) {
      return;
    }
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Copying to "{0}"', to),
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          abort.abort();
        });
        let shownAt = 0;
        try {
          return await deps.service.transfer({
            source: { target: targetOf(start.connectionId, fromScope), scope: fromScope },
            destination: { target: targetOf(toConnection, toScope), scope: toScope },
            tables: picked.map((item) => item.name),
            content,
            existing,
            signal: abort.signal,
            onProgress: (state) => {
              const now = Date.now();
              if (now - shownAt >= PROGRESS_INTERVAL_MS) {
                shownAt = now;
                progress.report({
                  message: vscode.l10n.t(
                    '{0}: {1} rows · table {2} of {3}',
                    state.table,
                    state.rows,
                    state.tablesDone + 1,
                    state.tablesTotal,
                  ),
                });
              }
            },
          });
        } finally {
          subscription.dispose();
        }
      },
    );
    deps.refresh(toConnection);
    await showOutcome(report, from, to);
  };
  return { transfer, duplicate };
}

async function pickContent(): Promise<TransferContent | undefined> {
  const items: (vscode.QuickPickItem & { content: TransferContent })[] = [
    { label: vscode.l10n.t('Structure and data'), content: 'all' },
    { label: vscode.l10n.t('Structure only'), content: 'structure' },
    {
      label: vscode.l10n.t('Data only'),
      description: vscode.l10n.t('into tables that are already there'),
      content: 'data',
    },
  ];
  return (
    await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Copy to Another Connection'),
      placeHolder: vscode.l10n.t('What should be copied?'),
    })
  )?.content;
}

async function pickExisting(content: TransferContent): Promise<ExistingTable | undefined> {
  const items: (vscode.QuickPickItem & { existing: ExistingTable })[] = [
    ...(content === 'data'
      ? []
      : [
          {
            label: vscode.l10n.t('Replace them'),
            description: vscode.l10n.t('DROP and CREATE again'),
            existing: 'replace' as const,
          },
        ]),
    {
      label: vscode.l10n.t('Add the rows to them'),
      description: vscode.l10n.t('into the columns both tables have'),
      existing: 'append',
    },
    { label: vscode.l10n.t('Leave them as they are'), existing: 'skip' },
  ];
  return (
    await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Copy to Another Connection'),
      placeHolder: vscode.l10n.t('When the target already has a table of that name'),
    })
  )?.existing;
}

async function confirm(
  deps: TransferCommandDeps,
  connectionId: string,
  count: number,
  from: string,
  to: string,
): Promise<boolean> {
  const policy = policyOf(deps.store.get(connectionId));
  const verdict = changeVerdict(policy);
  if (verdict === 'refuse') {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('"{0}" is read-only: nothing can be copied into it.', policy.name),
    );
    return false;
  }
  const question = vscode.l10n.t('Copy {0} tables from "{1}" to "{2}"?', count, from, to);
  const copy = vscode.l10n.t('Copy');
  const choice = await vscode.window.showWarningMessage(
    verdict === 'confirm'
      ? vscode.l10n.t('PRODUCTION "{0}": {1}', policy.name, question)
      : question,
    {
      modal: true,
      detail: vscode.l10n.t(
        'Types and defaults are translated for the target database; what cannot be carried over is listed in the report.',
      ),
    },
    copy,
  );
  return choice === copy;
}

/** The totals of a copy, with the report a click away when there is something to read. */
export async function showOutcome(report: TransferReport, from: string, to: string): Promise<void> {
  const copied = report.tables.filter((table) => table.outcome === 'copied').length;
  const summary = vscode.l10n.t(
    'Copied {0} tables, {1} rows, in {2}',
    copied,
    report.rows,
    formatDuration(report.durationMs),
  );
  const showReport = vscode.l10n.t('Show Report');
  const failed = report.tables.some((table) => table.error !== undefined);
  const message =
    report.outcome === 'cancelled' ? `${vscode.l10n.t('Cancelled')}. ${summary}` : summary;
  const choice = !worthReading(report)
    ? await vscode.window.showInformationMessage(message)
    : failed
      ? await vscode.window.showWarningMessage(message, showReport)
      : await vscode.window.showInformationMessage(message, showReport);
  if (choice === showReport) {
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: transferReportText(report, from, to, reportTexts()),
    });
    await vscode.window.showTextDocument(document);
  }
}

function reportTexts(): TransferReportTexts {
  return {
    title: (from, to) => vscode.l10n.t('Copy from "{0}" to "{1}"', from, to),
    totals: (copied, rows, duration) =>
      vscode.l10n.t('Copied {0} tables, {1} rows, in {2}', copied, rows, duration),
    cancelled: vscode.l10n.t('Cancelled'),
    copied: (rows) => vscode.l10n.t('{0} rows', rows),
    created: vscode.l10n.t('Created on the target'),
    skipped: vscode.l10n.t('Left as it was: the target already has it'),
    failed: (error) => vscode.l10n.t('Failed: {0}', error),
    note: (note) => noteText(note),
  };
}

function noteText(note: TransferNote): string {
  switch (note.kind) {
    case 'default-dropped':
      return vscode.l10n.t(
        'Column {0}: default {1} has no equivalent on the target and was left out',
        note.column,
        note.expression,
      );
    case 'auto-increment-dropped':
      return vscode.l10n.t('Column {0}: the target cannot number it automatically', note.column);
    case 'key-dropped':
      return vscode.l10n.t(
        'Foreign key {0}: {1} is not copied with it, so the key was left out',
        note.key,
        note.target,
      );
    case 'generated-skipped':
      return vscode.l10n.t('Column {0} is computed and was left out', note.column);
    case 'columns-skipped':
      return vscode.l10n.t('Columns the target table does not have: {0}', note.columns.join(', '));
  }
}

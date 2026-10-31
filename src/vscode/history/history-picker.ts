import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import type { HistoryEntry, QueryHistory } from '../../services/history';
import { formatDuration, formatWhen, summaryLine } from '../../services/history-format';
import { COMMAND_IDS } from '../command-ids';
import type { QueryEditors } from '../editor/query-editor';

export interface HistoryPickerDeps {
  readonly history: QueryHistory;
  readonly store: ConnectionStore;
  readonly editors: QueryEditors;
}

interface HistoryItem extends vscode.QuickPickItem {
  readonly entry: HistoryEntry;
}

const RUN = { iconPath: new vscode.ThemeIcon('play'), tooltip: vscode.l10n.t('Run again') };
const COPY = { iconPath: new vscode.ThemeIcon('copy'), tooltip: vscode.l10n.t('Copy SQL') };
const DELETE = {
  iconPath: new vscode.ThemeIcon('trash'),
  tooltip: vscode.l10n.t('Remove from history'),
};
const FILTER = {
  iconPath: new vscode.ThemeIcon('filter'),
  tooltip: vscode.l10n.t('Filter by connection'),
};
const CLEAR = {
  iconPath: new vscode.ThemeIcon('clear-all'),
  tooltip: vscode.l10n.t('Clear history'),
};

function describe(entry: HistoryEntry, store: ConnectionStore): HistoryItem {
  const name = store.get(entry.connectionId)?.name ?? entry.connectionName;
  const outcome = entry.ok
    ? entry.rows !== undefined
      ? vscode.l10n.t('{0} rows', entry.rows)
      : entry.affected !== undefined
        ? vscode.l10n.t('{0} rows affected', entry.affected)
        : vscode.l10n.t('done')
    : (entry.error ?? vscode.l10n.t('failed'));
  const parts = [
    formatWhen(entry.executedAt, Date.now()),
    formatDuration(entry.durationMs),
    outcome,
    ...(entry.runs > 1 ? [`×${entry.runs}`] : []),
    ...(entry.redacted === true ? [vscode.l10n.t('secrets masked')] : []),
  ];
  return {
    label: `${entry.ok ? '$(check)' : '$(error)'} ${summaryLine(entry.sql)}`,
    description: entry.database === undefined ? name : `${name} · ${entry.database}`,
    detail: parts.join(' · '),
    // The picker only matches on what it shows; the text is filtered here, on the whole SQL.
    alwaysShow: true,
    buttons: [RUN, COPY, DELETE],
    entry,
  };
}

/** Opens the entry's SQL in a new editor on its connection, and optionally runs it. */
async function reuse(deps: HistoryPickerDeps, entry: HistoryEntry, run: boolean): Promise<void> {
  const known = deps.store.get(entry.connectionId) !== undefined;
  const binding = known
    ? {
        connectionId: entry.connectionId,
        ...(entry.database === undefined ? {} : { database: entry.database }),
      }
    : undefined;
  if (!known) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The connection "{0}" no longer exists; pick another one to run this.',
        entry.connectionName,
      ),
    );
  }
  await deps.editors.newQuery(binding, entry.sql);
  if (!run) {
    return;
  }
  if (!known) {
    return;
  }
  if (entry.redacted === true) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('A secret in this statement was masked, so it was opened but not run.'),
    );
    return;
  }
  await vscode.commands.executeCommand(COMMAND_IDS.runAll);
}

/** Narrows the history to one connection and/or one table, e.g. from a table's own bar. */
export interface HistoryScope {
  readonly connectionId?: string;
  readonly table?: string;
}

/** The scope a command was given, if it is one: anything else (a tree node) means all. */
export function historyScopeOf(value: unknown): HistoryScope {
  if (typeof value !== 'object' || value === null || 'kind' in value) {
    return {};
  }
  const { connectionId, table } = value as { connectionId?: unknown; table?: unknown };
  return {
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
    ...(typeof table === 'string' ? { table } : {}),
  };
}

/** The query history: search as you type, filter by connection, reopen or rerun. */
export function showHistory(deps: HistoryPickerDeps, only: HistoryScope = {}): void {
  const pick = vscode.window.createQuickPick<HistoryItem>();
  let connectionId: string | undefined = only.connectionId;
  const table = only.table;
  const subscriptions: vscode.Disposable[] = [pick];

  const refresh = (): void => {
    const filter = deps.store.get(connectionId ?? '')?.name;
    const where = [filter ?? connectionId, table].filter((part) => part !== undefined);
    pick.title =
      where.length === 0
        ? vscode.l10n.t('Query History')
        : vscode.l10n.t('Query History · {0}', where.join(' · '));
    pick.placeholder = vscode.l10n.t('Search the SQL of past queries');
    pick.items = deps.history
      .list({
        text: pick.value,
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(table === undefined ? {} : { table }),
      })
      .map((entry) => describe(entry, deps.store));
  };

  pick.buttons = [FILTER, CLEAR];
  pick.matchOnDescription = false;
  pick.matchOnDetail = false;
  refresh();

  subscriptions.push(
    pick.onDidChangeValue(refresh),
    pick.onDidAccept(() => {
      const [item] = pick.selectedItems;
      pick.hide();
      if (item !== undefined) {
        void reuse(deps, item.entry, false);
      }
    }),
    pick.onDidTriggerItemButton(({ item, button }) => {
      if (button === RUN) {
        pick.hide();
        void reuse(deps, item.entry, true);
      } else if (button === COPY) {
        void vscode.env.clipboard.writeText(item.entry.sql);
        void vscode.window.setStatusBarMessage(vscode.l10n.t('SQL copied'), 2000);
      } else if (button === DELETE) {
        deps.history.remove(item.entry.id);
        refresh();
      }
    }),
    pick.onDidTriggerButton(async (button) => {
      if (button === FILTER) {
        const choices = deps.history.connections();
        const chosen = await vscode.window.showQuickPick(
          [
            { label: vscode.l10n.t('All connections'), id: undefined as string | undefined },
            ...choices.map((choice) => ({
              label: choice.name,
              description: String(choice.count),
              id: choice.id,
            })),
          ],
          { placeHolder: vscode.l10n.t('Show the history of…') },
        );
        if (chosen !== undefined) {
          connectionId = chosen.id;
          refresh();
        }
        pick.show();
      } else if (button === CLEAR) {
        const scope = connectionId;
        const clear = vscode.l10n.t('Clear');
        const choice = await vscode.window.showWarningMessage(
          scope === undefined
            ? vscode.l10n.t('Remove every query from the history?')
            : vscode.l10n.t('Remove the queries of this connection from the history?'),
          { modal: true },
          clear,
        );
        if (choice === clear) {
          deps.history.clear(scope);
          refresh();
        }
        pick.show();
      }
    }),
    pick.onDidHide(() => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    }),
  );
  pick.show();
}

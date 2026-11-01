// Pinning and the history of results (V12.5). A pinned result stays when its query is run
// again; a result a re-run pushed aside is not lost, it waits in the history, and "Result
// History…" brings one back as a tab. Nothing is written to disk.

import * as vscode from 'vscode';
import { formatCount } from '../core/number-format';
import type { ResultStore, ResultSummary } from '../services/result-store';
import { tabTitle } from '../shared/protocols/result-grid';

export interface ResultHistoryDeps {
  readonly results: Pick<ResultStore, 'history' | 'restore' | 'pin' | 'get'>;
  /** Shows the results panel of a document with this result selected. */
  readonly show: (documentUri: string, resultId: string) => void;
}

export interface ResultHistoryHandlers {
  /** Asks which pushed-aside result to bring back; of one document, or of all. */
  readonly showHistory: (documentUri?: string) => Promise<void>;
  /** Pins the result, or lets go of the pin; returns whether it is pinned now. */
  readonly togglePin: (resultId: string) => boolean | undefined;
}

interface HistoryItem extends vscode.QuickPickItem {
  readonly summary: ResultSummary;
}

function documentName(documentUri: string): string {
  const path = vscode.Uri.parse(documentUri).path;
  return path.slice(path.lastIndexOf('/') + 1) || documentUri;
}

export function resultHistoryHandlers(deps: ResultHistoryDeps): ResultHistoryHandlers {
  return {
    showHistory: async (documentUri) => {
      const entries = deps.results
        .history(documentUri)
        .filter((summary) => summary.columns.length > 0);
      if (entries.length === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('The history is empty: no result has been replaced by a re-run yet'),
        );
        return;
      }
      const items: HistoryItem[] = entries.map((summary) => ({
        label: tabTitle(summary.statement, 60),
        description: documentUri === undefined ? documentName(summary.documentUri) : '',
        detail: vscode.l10n.t(
          '{0} rows, {1} columns',
          formatCount(summary.rowCount, vscode.env.language),
          summary.columns.length,
        ),
        summary,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t('Result History'),
        placeHolder: vscode.l10n.t('Pick a result to bring back'),
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (picked === undefined) {
        return;
      }
      const restored = deps.results.restore(picked.summary.id);
      if (restored === undefined) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('That result is gone: the memory for results ran out'),
        );
        return;
      }
      deps.show(restored.documentUri, restored.id);
    },
    togglePin: (resultId) => {
      const summary = deps.results.get(resultId);
      if (summary === undefined) {
        return undefined;
      }
      const pinned = !summary.pinned;
      deps.results.pin(resultId, pinned);
      return pinned;
    },
  };
}

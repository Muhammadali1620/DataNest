// "Compare Results…" (V12.4): two results of queries are picked from the ones shown in
// this session, the columns that identify a row are asked for, and the editor's own diff
// view opens on two listings with the rows in matching order. Nothing is kept on disk.

import * as vscode from 'vscode';
import { formatCount } from '../core/number-format';
import { DbError } from '../core/errors';
import type { ResultStore, ResultSummary } from '../services/result-store';
import {
  type ComparedResult,
  commonColumns,
  compareResults,
  comparisonSummary,
} from '../services/result-compare';
import { tabTitle } from '../shared/protocols/result-grid';

export const COMPARE_SCHEME = 'datanest-compare';

/** Listings kept for open diff views; the oldest are forgotten past this. */
const MAX_LISTINGS = 20;

/** The text of the two sides of a comparison, served to the diff view. */
export class CompareListings implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private counter = 0;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  add(name: string, text: string): vscode.Uri {
    this.counter += 1;
    const uri = vscode.Uri.from({
      scheme: COMPARE_SCHEME,
      path: `/${this.counter}/${name.replace(/[\\/]/gu, '-')}.txt`,
    });
    this.texts.set(uri.toString(), text);
    for (const old of [...this.texts.keys()].slice(0, -MAX_LISTINGS * 2)) {
      this.texts.delete(old);
    }
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export interface CompareResultsDeps {
  readonly results: Pick<ResultStore, 'list' | 'allRows'>;
  readonly listings: CompareListings;
}

interface ResultItem extends vscode.QuickPickItem {
  readonly summary: ResultSummary;
}

function documentName(documentUri: string): string {
  const path = vscode.Uri.parse(documentUri).path;
  return path.slice(path.lastIndexOf('/') + 1) || documentUri;
}

function itemOf(summary: ResultSummary): ResultItem {
  return {
    label: tabTitle(summary.statement, 60),
    description: documentName(summary.documentUri),
    detail: vscode.l10n.t(
      '{0} rows, {1} columns',
      formatCount(summary.rowCount, vscode.env.language),
      summary.columns.length,
    ),
    summary,
  };
}

export function compareResultsHandler(deps: CompareResultsDeps): () => Promise<void> {
  const side = (summary: ResultSummary): ComparedResult | undefined => {
    const rows = deps.results.allRows(summary.id);
    return rows === undefined
      ? undefined
      : {
          title: tabTitle(summary.statement, 40),
          columns: summary.columns.map((column) => column.name),
          rows,
        };
  };

  return async () => {
    const candidates = deps.results
      .list()
      .filter((summary) => summary.error === undefined && summary.columns.length > 0);
    if (candidates.length < 2) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Run two queries first: there must be two results to compare'),
      );
      return;
    }
    const first = await vscode.window.showQuickPick(candidates.map(itemOf), {
      title: vscode.l10n.t('Compare Results'),
      placeHolder: vscode.l10n.t('Pick the first result'),
      matchOnDescription: true,
    });
    if (first === undefined) {
      return;
    }
    const second = await vscode.window.showQuickPick(
      candidates.filter((summary) => summary.id !== first.summary.id).map(itemOf),
      {
        title: vscode.l10n.t('Compare Results'),
        placeHolder: vscode.l10n.t('Pick the result to compare it with'),
        matchOnDescription: true,
      },
    );
    if (second === undefined) {
      return;
    }
    const shared = commonColumns(
      first.summary.columns.map((column) => column.name),
      second.summary.columns.map((column) => column.name),
    );
    if (shared.length === 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('The two results have no column in common'),
      );
      return;
    }
    const keyItems = await vscode.window.showQuickPick(
      shared.map((column) => ({
        label: column.name,
        picked: column.name.toLowerCase() === 'id',
      })),
      {
        title: vscode.l10n.t('Compare Results'),
        placeHolder: vscode.l10n.t(
          'Pick the columns that identify a row; pick none to compare whole rows',
        ),
        canPickMany: true,
      },
    );
    if (keyItems === undefined) {
      return;
    }
    const left = side(first.summary);
    const right = side(second.summary);
    if (left === undefined || right === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('A result is gone; run the query again to compare it'),
      );
      return;
    }
    try {
      const comparison = compareResults(
        left,
        right,
        keyItems.map((item) => item.label),
      );
      const leftUri = deps.listings.add(left.title, comparison.leftText);
      const rightUri = deps.listings.add(right.title, comparison.rightText);
      await vscode.commands.executeCommand(
        'vscode.diff',
        leftUri,
        rightUri,
        vscode.l10n.t('{0} ↔ {1}', left.title, right.title),
      );
      const notes = [
        comparisonSummary(comparison),
        comparison.onlyLeftColumns.length > 0
          ? vscode.l10n.t('Only in the first: {0}', comparison.onlyLeftColumns.join(', '))
          : undefined,
        comparison.onlyRightColumns.length > 0
          ? vscode.l10n.t('Only in the second: {0}', comparison.onlyRightColumns.join(', '))
          : undefined,
      ].filter((note) => note !== undefined);
      void vscode.window.showInformationMessage(notes.join('. '));
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof DbError ? error.message : vscode.l10n.t('Could not compare the results'),
      );
    }
  };
}

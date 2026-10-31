// What the page is told after SQL typed on it ran (V12.1). Free of `vscode`.

import type { ResultSummary } from './result-store';

export type SqlTextOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error?: string };

/**
 * The first failed statement's message; no message when the run was stopped by the user,
 * who needs no error for their own choice.
 */
export function sqlTextOutcome(
  results: readonly Pick<ResultSummary, 'error'>[],
  cancelled: boolean,
): SqlTextOutcome {
  const failed = results.find((result) => result.error !== undefined);
  if (failed?.error !== undefined) {
    return failed.error.code === 'cancelled'
      ? { ok: false }
      : { ok: false, error: failed.error.message };
  }
  return cancelled ? { ok: false } : { ok: true };
}

/**
 * The column to show a results panel in: where it already is, so paging or sorting never
 * moves it; only a panel that has no column yet opens beside the editor.
 */
export function revealColumn<Column>(current: Column | undefined, beside: Column): Column {
  return current ?? beside;
}

/** What SQL edited on a result's page replaces: that result, or everything of a table view. */
export function replacementFor(
  isTableView: boolean,
  resultId: string,
): { readonly resultId: string } | { readonly all: true } {
  return isTableView ? { all: true } : { resultId };
}

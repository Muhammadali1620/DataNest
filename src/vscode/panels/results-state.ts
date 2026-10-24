// What the result page is told about a document's results. Free of `vscode`, so the
// tab building and the active-tab rules are covered by unit tests.

import type { ResultSummary } from '../../services/result-store';
import { tabTitle, type ResultGridState, type ResultTab } from '../../shared/protocols/result-grid';

/** The result tabs of one document. */
export function buildState(
  summaries: readonly ResultSummary[],
  activeId: string | undefined,
  running: boolean,
): ResultGridState {
  const tabs: ResultTab[] = summaries.map((summary) => ({
    id: summary.id,
    title: tabTitle(summary.statement),
    statement: summary.statement,
    columns: summary.columns.map((column) => ({
      name: column.name,
      ...(column.dataType === undefined ? {} : { dataType: column.dataType }),
    })),
    rowCount: summary.rowCount,
    truncated: summary.truncated,
    ...(summary.affectedRows === undefined ? {} : { affectedRows: summary.affectedRows }),
    durationMs: summary.durationMs,
    ...(summary.error === undefined ? {} : { error: summary.error }),
    ...(summary.sort === undefined ? {} : { sort: summary.sort }),
  }));
  // The newest tab is the one the user just produced, unless they picked another.
  const active =
    activeId !== undefined && tabs.some((tab) => tab.id === activeId) ? activeId : tabs.at(-1)?.id;
  return { tabs, ...(active === undefined ? {} : { activeId: active }), running };
}

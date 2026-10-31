// What the result page is told about a document's results. Free of `vscode`, so the
// tab building and the active-tab rules are covered by unit tests.

import { linksOf } from '../../services/result-links';
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
    ...(summary.page === undefined ? {} : { page: summary.page }),
    ...(summary.filter === undefined ? {} : { filter: summary.filter }),
    ...(summary.edit === undefined
      ? {}
      : summary.edit.editable
        ? {
            edit: {
              editable: true,
              ...(summary.edit.keyless === true ? { keyless: true } : {}),
              columns: summary.edit.columns.map((column) =>
                column === null
                  ? null
                  : {
                      dataType: column.dataType,
                      kind: column.kind,
                      nullable: column.nullable,
                      ...(column.options === undefined ? {} : { options: [...column.options] }),
                    },
              ),
            },
          }
        : { edit: { editable: false, reason: summary.edit.reason } }),
    ...(summary.edit?.editable === true && linksOf(summary.edit).length > 0
      ? { links: linksOf(summary.edit) }
      : {}),
    changedCells: summary.changedCells,
    insertedRows: summary.insertedRows,
    deletedRows: summary.deletedRows,
    revision: summary.revision,
  }));
  // The newest tab is the one the user just produced, unless they picked another.
  const active =
    activeId !== undefined && tabs.some((tab) => tab.id === activeId) ? activeId : tabs.at(-1)?.id;
  return { tabs, ...(active === undefined ? {} : { activeId: active }), running };
}

/**
 * Where in the document the error of a result points. A server reports the offset
 * inside the statement it was given, so the statement's own position is added.
 * The result is clamped to the document, which may have been edited since.
 */
export function errorOffsetOf(
  summary: Pick<ResultSummary, 'statementStart' | 'statement' | 'error'>,
  documentLength: number,
): number | undefined {
  if (summary.error === undefined) {
    return undefined;
  }
  const within = summary.error.position ?? 0;
  const offset = summary.statementStart + Math.max(0, within);
  return Math.max(0, Math.min(offset, Math.max(0, documentLength)));
}

/**
 * The tab to keep selected after the results changed: the same one, or the one that
 * replaced it in place; undefined (the newest) when it is gone for another reason.
 */
export function followActive(
  summaries: readonly Pick<ResultSummary, 'id'>[],
  activeId: string | undefined,
  successorOf: (id: string) => string | undefined,
): string | undefined {
  if (activeId === undefined || summaries.some((summary) => summary.id === activeId)) {
    return activeId;
  }
  return successorOf(activeId);
}

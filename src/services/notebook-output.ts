// How a result looks in a notebook cell (V12.1): a table as HTML for the notebook's own
// viewer, and the same rows as plain text for whatever cannot show HTML (copying, other
// editors' notebook viewers). Free of `vscode`.

import type { ResultSummary } from './result-store';
import { cellText } from '../shared/cell-text';
import type { CellValue } from '../shared/cell-value';
import { msg } from '../core/user-message';

/** Rows shown in a cell; the rest stay in the result, and the line says how many. */
export const NOTEBOOK_ROW_LIMIT = 500;

/** Text of a value is cut here in a cell, so one huge value cannot fill the notebook. */
export const NOTEBOOK_CELL_LIMIT = 2000;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shown(value: CellValue): string {
  const full = cellText(value, { nullText: 'NULL' });
  return full.length > NOTEBOOK_CELL_LIMIT ? `${full.slice(0, NOTEBOOK_CELL_LIMIT)}…` : full;
}

export interface NotebookOutput {
  readonly html: string;
  readonly text: string;
}

const TABLE_STYLE =
  'border-collapse:collapse;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px)';
const CELL_STYLE =
  'border:1px solid var(--vscode-editorWidget-border,#888);padding:2px 8px;text-align:left;vertical-align:top;white-space:pre-wrap';
const HEAD_STYLE = `${CELL_STYLE};font-weight:600;background:var(--vscode-editorWidget-background,transparent)`;
const NOTE_STYLE = 'opacity:0.75;font-size:0.9em;margin:4px 0';

/** The footer line: how many rows, whether the list was cut, how long it took. */
export function footerLine(
  summary: Pick<ResultSummary, 'rowCount' | 'truncated' | 'durationMs'>,
  shownRows: number,
): string {
  const parts = [msg('{0} rows', summary.rowCount)];
  if (shownRows < summary.rowCount) {
    parts.push(msg('first {0} shown', shownRows));
  }
  if (summary.truncated) {
    parts.push(msg('the server had more: the row limit cut the result'));
  }
  parts.push(msg('{0} ms', summary.durationMs));
  return parts.join(' · ');
}

/** A result with columns as a table; rows beyond the limit are left out. */
export function tableOutput(
  summary: Pick<ResultSummary, 'columns' | 'rowCount' | 'truncated' | 'durationMs'>,
  rows: readonly (readonly CellValue[])[],
): NotebookOutput {
  const visible = rows.slice(0, NOTEBOOK_ROW_LIMIT);
  const head = summary.columns
    .map((column) => `<th style="${HEAD_STYLE}">${escapeHtml(column.name)}</th>`)
    .join('');
  const body = visible
    .map(
      (row) =>
        `<tr>${summary.columns
          .map((_, index) => {
            const value = row[index] ?? null;
            const text = escapeHtml(shown(value));
            return `<td style="${CELL_STYLE}">${value === null ? `<i style="opacity:0.6">${text}</i>` : text}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const footer = footerLine(summary, visible.length);
  const escapeText = (value: string): string =>
    value.replaceAll('\t', ' ').replaceAll(/\r?\n/gu, ' ');
  const text = [
    summary.columns.map((column) => escapeText(column.name)).join('\t'),
    ...visible.map((row) =>
      summary.columns.map((_, index) => escapeText(shown(row[index] ?? null))).join('\t'),
    ),
    footer,
  ].join('\n');
  return {
    html: `<table style="${TABLE_STYLE}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><div style="${NOTE_STYLE}">${escapeHtml(footer)}</div>`,
    text,
  };
}

/** The line for a statement that brings no rows. */
export function doneLine(summary: Pick<ResultSummary, 'affectedRows' | 'durationMs'>): string {
  return summary.affectedRows === undefined
    ? msg('Done · {0} ms', summary.durationMs)
    : msg('{0} rows affected · {1} ms', summary.affectedRows, summary.durationMs);
}

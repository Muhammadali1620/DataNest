// Turning a stored result into a file. The whole result is exported, not the part
// the grid happens to show, because the rows live in the host (ARCHITECTURE.md D6).

import { cellJson } from '../shared/cell-text';
import type { CellValue } from '../shared/cell-value';
import { toCsv } from '../shared/csv';
import type { ResultEdit } from '../core/model/editability';
import type { Dialect, ResultColumn } from '../drivers/driver';
import { columnNames } from './column-names';
import { copyAs } from './copy-as';

export { columnNames };
import { toXlsx, XlsxLimitError } from './xlsx';

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMATS = ['csv', 'json', 'sql', 'markdown', 'xlsx'] as const;

export function isExportFormat(value: unknown): value is ExportFormat {
  return EXPORT_FORMATS.some((format) => format === value);
}

export interface ExportInput {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly (readonly CellValue[])[];
  /** Needed for SQL: how to quote names and write values. */
  readonly dialect?: Dialect | undefined;
  /** Where the rows came from, so INSERTs name the real table and columns. */
  readonly edit?: ResultEdit | undefined;
}

/** The file extension a format writes. */
export function extensionOf(format: ExportFormat): string {
  return format === 'markdown' ? 'md' : format;
}

/** What went wrong when a result cannot be written in a format. */
export type ExportError = 'no-rows' | 'nothing-to-write' | 'too-large';

export type ExportOutcome =
  | { readonly ok: true; readonly data: Uint8Array }
  | { readonly ok: false; readonly error: ExportError };

/** The file contents for any format, as bytes. */
export function exportBytes(input: ExportInput, format: ExportFormat): ExportOutcome {
  const encode = (text: string): ExportOutcome => ({
    ok: true,
    data: new TextEncoder().encode(text),
  });
  switch (format) {
    case 'csv':
    case 'json':
      return encode(exportResult(input, format));
    case 'markdown':
    case 'sql': {
      const last = Math.max(0, input.columns.length - 1);
      const outcome = copyAs({
        format: format === 'sql' ? 'insert' : 'markdown',
        columns: input.columns,
        rows: input.rows,
        left: 0,
        right: last,
        dialect: input.dialect,
        edit: input.edit,
      });
      return outcome.ok ? encode(`${outcome.text}\n`) : { ok: false, error: 'nothing-to-write' };
    }
    case 'xlsx':
      try {
        return {
          ok: true,
          data: toXlsx({ header: columnNames(input.columns), rows: input.rows }),
        };
      } catch (error) {
        if (error instanceof XlsxLimitError) {
          return { ok: false, error: 'too-large' };
        }
        throw error;
      }
  }
}

/**
 * The file contents. JSON is an array of objects keyed by column name, with exact
 * numbers kept as strings so no value is rounded on the way out.
 */
export function exportResult(input: ExportInput, format: 'csv' | 'json'): string {
  const names = columnNames(input.columns);
  if (format === 'csv') {
    return toCsv(input.rows, { header: names });
  }
  const records = input.rows.map((row) => {
    const record: Record<string, unknown> = {};
    for (const [index, name] of names.entries()) {
      record[name] = cellJson(row[index] ?? null);
    }
    return record;
  });
  return `${JSON.stringify(records, undefined, 2)}\n`;
}

/** A file name suggestion from the statement, safe on every platform. */
export function suggestedFileName(statement: string, format: ExportFormat): string {
  const words = statement
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
  return `${words === '' ? 'result' : words}.${extensionOf(format)}`;
}

// Turning a stored result into a file. The whole result is exported, not the part
// the grid happens to show, because the rows live in the host (ARCHITECTURE.md D6).

import { cellJson } from '../shared/cell-text';
import type { CellValue } from '../shared/cell-value';
import { toCsv } from '../shared/csv';
import type { ResultColumn } from '../drivers/driver';

export type ExportFormat = 'csv' | 'json';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'json'];

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'csv' || value === 'json';
}

export interface ExportInput {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly (readonly CellValue[])[];
}

/** The file extension a format writes. */
export function extensionOf(format: ExportFormat): string {
  return format === 'csv' ? 'csv' : 'json';
}

/**
 * The file contents. JSON is an array of objects keyed by column name, with exact
 * numbers kept as strings so no value is rounded on the way out.
 */
export function exportResult(input: ExportInput, format: ExportFormat): string {
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

/**
 * Column names for a file header. Unnamed columns get a position, and duplicates
 * are numbered, so a JSON object never silently loses a column.
 */
export function columnNames(columns: readonly ResultColumn[]): string[] {
  const used = new Set<string>();
  return columns.map((column, index) => {
    const base = column.name === '' ? `column${index + 1}` : column.name;
    let candidate = base;
    // Counting up until the name is free also covers a column literally called
    // `id_2` next to two columns called `id`.
    for (let attempt = 2; used.has(candidate); attempt++) {
      candidate = `${base}_${attempt}`;
    }
    used.add(candidate);
    return candidate;
  });
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

// Tab-separated text for the clipboard. The point is that it pastes into Excel,
// Sheets and Numbers unchanged, so a value with a tab or a newline is quoted the
// way spreadsheets expect rather than silently mangled.

import { cellText } from './cell-text';
import type { CellValue } from './cell-value';

export interface TsvOptions {
  /** Prepend a row of column names. */
  readonly header?: readonly string[];
  /** What NULL becomes; empty by default, which a spreadsheet shows as blank. */
  readonly nullText?: string;
}

/** True when a value must be quoted for a spreadsheet to read it as one cell. */
export function needsQuoting(text: string): boolean {
  return text.includes('\t') || text.includes('\n') || text.includes('\r') || text.includes('"');
}

/** One field, quoted only when it has to be. */
export function tsvField(text: string): string {
  return needsQuoting(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Rows as TSV. Line endings are `\r\n`, which is what spreadsheets expect from
 * the clipboard on every platform.
 */
export function toTsv(rows: readonly (readonly CellValue[])[], options: TsvOptions = {}): string {
  const lines: string[] = [];
  if (options.header !== undefined) {
    lines.push(options.header.map(tsvField).join('\t'));
  }
  for (const row of rows) {
    lines.push(
      row
        .map((value) =>
          tsvField(
            cellText(value, options.nullText === undefined ? {} : { nullText: options.nullText }),
          ),
        )
        .join('\t'),
    );
  }
  return lines.join('\r\n');
}

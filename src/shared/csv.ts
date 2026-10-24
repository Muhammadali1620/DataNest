// CSV the way RFC 4180 describes it, which is what spreadsheets and pandas read:
// fields quoted only when they must be, quotes doubled inside, CRLF line endings.

import { cellText } from './cell-text';
import type { CellValue } from './cell-value';

export interface CsvOptions {
  /** Column names as the first line. */
  readonly header?: readonly string[];
  /** Field separator; a semicolon suits locales where the comma is a decimal mark. */
  readonly delimiter?: string;
  /** What NULL becomes. Empty by default, which readers treat as missing. */
  readonly nullText?: string;
}

export const DEFAULT_DELIMITER = ',';

/** True when a field cannot be written bare. */
export function needsQuoting(text: string, delimiter: string): boolean {
  return (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text.startsWith(' ') ||
    text.endsWith(' ')
  );
}

export function csvField(text: string, delimiter: string = DEFAULT_DELIMITER): string {
  return needsQuoting(text, delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: readonly (readonly CellValue[])[], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? DEFAULT_DELIMITER;
  const nullText = options.nullText ?? '';
  const lines: string[] = [];
  if (options.header !== undefined) {
    lines.push(options.header.map((name) => csvField(name, delimiter)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(
      row.map((value) => csvField(cellText(value, { nullText }), delimiter)).join(delimiter),
    );
  }
  // A trailing newline is what most tools expect at the end of a text file.
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}

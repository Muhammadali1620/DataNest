// Column names for files and copied text.

import type { ResultColumn } from '../drivers/driver';

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

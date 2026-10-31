// Planning an export of every table of a database into a folder (V12.1). Free of
// `vscode`, so naming and ordering are covered by unit tests.

import type { TableInfo, TableRef } from '../core/model/objects';
import { type ExportFormat, extensionOf } from './result-export';

export interface PlannedFile {
  readonly table: TableRef;
  readonly fileName: string;
}

/** Characters a file name cannot hold on some system, and control characters. */
function safeName(name: string): string {
  const cleaned = Array.from(name, (char) =>
    char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '_' : char,
  )
    .join('')
    .replace(/_{2,}/gu, '_')
    .replace(/^\.+/u, '_');
  return cleaned === '' ? 'table' : cleaned;
}

/**
 * One file per table, views left out; names are the table's, made safe for a file system
 * and kept apart when two tables differ only by case or by unsafe characters.
 */
export function planDatabaseExport(
  scope: { readonly database?: string; readonly schema?: string },
  tables: readonly TableInfo[],
  format: ExportFormat,
): PlannedFile[] {
  const taken = new Set<string>();
  const plan: PlannedFile[] = [];
  for (const info of tables) {
    if (info.kind !== 'table') {
      continue;
    }
    const base = safeName(info.name);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
      name = `${base}-${n}`;
    }
    taken.add(name.toLowerCase());
    plan.push({
      table: {
        ...(scope.database === undefined ? {} : { database: scope.database }),
        ...(scope.schema === undefined ? {} : { schema: scope.schema }),
        name: info.name,
      },
      fileName: `${name}.${extensionOf(format)}`,
    });
  }
  return plan;
}

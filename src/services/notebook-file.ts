// The file of a SQL notebook (V12.1): `*.sqlnb`, JSON with the cells' text and the place
// the notebook runs in. Results are not saved in it: they can be huge, change with every
// run and would make every commit a wall of diff. Free of `vscode`; the editor's
// serializer (vscode/notebook/serializer.ts) only turns this into notebook data.

import { DbError } from '../core/errors';
import { msg } from '../core/user-message';

export const NOTEBOOK_TYPE = 'datanest-sql';
export const NOTEBOOK_EXTENSION = '.sqlnb';
export const NOTEBOOK_VERSION = 1;

export type NotebookCellKind = 'sql' | 'markdown';

export interface NotebookCellFile {
  readonly kind: NotebookCellKind;
  readonly source: string;
}

/** Where the notebook runs: a connection by the id the project file gives it, if it is one. */
export interface NotebookPlace {
  readonly connection?: string;
  /** The name of the connection when the file was saved, shown when the id is unknown. */
  readonly connectionName?: string;
  readonly database?: string;
}

export interface NotebookFile extends NotebookPlace {
  readonly cells: readonly NotebookCellFile[];
}

/** The byte order mark some editors put at the start of a file. */
const BOM = 0xfeff;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads the text of a notebook file. An empty file is an empty notebook (a new file made
 * in the explorer); anything else that is not a notebook is refused with the reason.
 */
export function parseNotebook(source: string): NotebookFile {
  if (source.trim() === '') {
    return { cells: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(source.charCodeAt(0) === BOM ? source.slice(1) : source);
  } catch {
    throw new DbError('syntax', msg('The file is not a SQL notebook: it is not valid JSON'));
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new DbError('syntax', msg('The file is not a SQL notebook'));
  }
  const record = data as Record<string, unknown>;
  if (typeof record.version === 'number' && record.version > NOTEBOOK_VERSION) {
    throw new DbError(
      'unsupported',
      msg('The notebook was made by a newer DataNest: update the extension to open it'),
    );
  }
  const rawCells = record.cells;
  if (rawCells !== undefined && !Array.isArray(rawCells)) {
    throw new DbError('syntax', msg('The file is not a SQL notebook: "cells" must be a list'));
  }
  const cells: NotebookCellFile[] = [];
  for (const raw of (rawCells ?? []) as unknown[]) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const cell = raw as Record<string, unknown>;
    const lines = cell.source;
    // A list of lines is how notebooks usually keep text; one string is accepted too.
    const body = Array.isArray(lines)
      ? lines.filter((line): line is string => typeof line === 'string').join('\n')
      : typeof lines === 'string'
        ? lines
        : '';
    cells.push({ kind: cell.kind === 'markdown' ? 'markdown' : 'sql', source: body });
  }
  const connection = text(record.connection);
  const connectionName = text(record.connectionName);
  const database = text(record.database);
  return {
    ...(connection === undefined ? {} : { connection }),
    ...(connectionName === undefined ? {} : { connectionName }),
    ...(database === undefined ? {} : { database }),
    cells,
  };
}

/** The text of a notebook file: one cell per few lines, so a change is a small diff. */
export function serializeNotebook(notebook: NotebookFile): string {
  return `${JSON.stringify(
    {
      version: NOTEBOOK_VERSION,
      ...(notebook.connection === undefined ? {} : { connection: notebook.connection }),
      ...(notebook.connectionName === undefined ? {} : { connectionName: notebook.connectionName }),
      ...(notebook.database === undefined ? {} : { database: notebook.database }),
      cells: notebook.cells.map((cell) => ({
        kind: cell.kind,
        source: cell.source === '' ? [] : cell.source.split(/\r?\n/u),
      })),
    },
    null,
    2,
  )}\n`;
}

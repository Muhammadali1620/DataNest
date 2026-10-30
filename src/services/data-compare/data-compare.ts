// Comparing the rows of two tables (V8.4), of the same database or of two different
// ones. Rows are matched by key, so neither order nor collation matters:
//   1. the target is read into key → hash of its compared values (a number per row);
//   2. the source is read and every row checked against that map;
//   3. only if needed, the target is read again for the values of rows to show.
// At most `ROW_LIMIT` rows a side, and `KEEP_ROWS` rows of each kind kept for the page
// and the sync script; the counts are always exact.

import { DbError } from '../../core/errors';
import type { TableRef } from '../../core/model/objects';
import type { Dialect, Session } from '../../drivers/driver';
import type { CellValue } from '../../shared/cell-value';
import { type ColumnMode, keyOf, rowHash } from './comparable';

export const ROW_LIMIT = 1_000_000;
export const KEEP_ROWS = 10_000;

export interface CompareTable {
  readonly table: TableRef;
  readonly dialect: Dialect;
  /** A session for reading; `release` gives it back. */
  readonly session: () => Promise<Session>;
  readonly release: () => Promise<void>;
}

export interface DataCompareRequest {
  readonly source: CompareTable;
  readonly target: CompareTable;
  /** Key columns, as named in the source and in the target, in the same order. */
  readonly key: readonly { readonly source: string; readonly target: string }[];
  /** Compared columns (not the key), paired the same way. */
  readonly columns: readonly { readonly source: string; readonly target: string }[];
  /** How each key and compared column compares, in that order; plain when absent. */
  readonly modes?: readonly ColumnMode[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DataCompareProgress) => void;
}

export interface DataCompareProgress {
  readonly phase: 'target' | 'source' | 'rows';
  readonly rows: number;
}

/** A row as kept: key values, then compared values, in request order. */
export type KeptRow = readonly CellValue[];

export interface DataCompareResult {
  readonly same: number;
  readonly different: number;
  readonly onlySource: number;
  readonly onlyTarget: number;
  /** Rows that differ: the source's and the target's values, key first. */
  readonly differentRows: readonly { readonly source: KeptRow; readonly target: KeptRow }[];
  readonly onlySourceRows: readonly KeptRow[];
  readonly onlyTargetRows: readonly KeptRow[];
  readonly durationMs: number;
}

export async function compareTableData(request: DataCompareRequest): Promise<DataCompareResult> {
  const started = Date.now();
  if (request.key.length === 0) {
    throw new DbError('unsupported', 'Rows can be compared only by key columns');
  }
  const width = request.key.length;
  const sourceColumns = [...request.key, ...request.columns].map((pair) => pair.source);
  const targetColumns = [...request.key, ...request.columns].map((pair) => pair.target);
  const progress = (phase: DataCompareProgress['phase'], rows: number): void => {
    request.onProgress?.({ phase, rows });
  };

  try {
    return await compare(request, width, sourceColumns, targetColumns, progress, started);
  } finally {
    await Promise.all([request.source.release(), request.target.release()]);
  }
}

/** Marks a target key the source has matched; hashes are never negative. */
const MATCHED = -1;

async function compare(
  request: DataCompareRequest,
  width: number,
  sourceColumns: readonly string[],
  targetColumns: readonly string[],
  progress: (phase: DataCompareProgress['phase'], rows: number) => void,
  started: number,
): Promise<DataCompareResult> {
  const modes = request.modes ?? [];
  const keyModes = modes.slice(0, width);
  const valueModes = modes.slice(width);
  // 1. The target: key → hash.
  const hashes = new Map<string, number>();
  await readRows(request.target, targetColumns, request.signal, (row, count) => {
    const key = keyOf(row.slice(0, width), keyModes);
    if (hashes.has(key)) {
      throw new DbError(
        'constraint',
        'Values of the key columns repeat in the target: pick columns that identify a row',
      );
    }
    hashes.set(key, rowHash(row.slice(width), valueModes));
    if (count % 5000 === 0) {
      progress('target', count);
    }
  });

  // 2. The source, checked against the map. A matched key is marked rather than
  // removed, so a repeated source key is noticed without a set of all source keys.
  let same = 0;
  let different = 0;
  let onlySource = 0;
  const onlySourceKeys = new Set<string>();
  const differing = new Map<string, KeptRow>();
  const onlySourceRows: KeptRow[] = [];
  await readRows(request.source, sourceColumns, request.signal, (row, count) => {
    const key = keyOf(row.slice(0, width), keyModes);
    const hash = hashes.get(key);
    if (hash === MATCHED || onlySourceKeys.has(key)) {
      throw new DbError(
        'constraint',
        'Values of the key columns repeat in the source: pick columns that identify a row',
      );
    }
    if (hash === undefined) {
      onlySourceKeys.add(key);
      onlySource += 1;
      if (onlySourceRows.length < KEEP_ROWS) {
        onlySourceRows.push(row);
      }
    } else {
      hashes.set(key, MATCHED);
      if (hash === rowHash(row.slice(width), valueModes)) {
        same += 1;
      } else {
        different += 1;
        if (differing.size < KEEP_ROWS) {
          differing.set(key, row);
        }
      }
    }
    if (count % 5000 === 0) {
      progress('source', count);
    }
  });
  onlySourceKeys.clear();
  let onlyTarget = 0;
  for (const hash of hashes.values()) {
    if (hash !== MATCHED) {
      onlyTarget += 1;
    }
  }

  // 3. The target again, for the values of the rows to show, until all are found.
  const targetOf = new Map<string, KeptRow>();
  const onlyTargetRows: KeptRow[] = [];
  const wantOnlyTarget = Math.min(onlyTarget, KEEP_ROWS);
  if (differing.size > 0 || wantOnlyTarget > 0) {
    progress('rows', 0);
    await readRows(request.target, targetColumns, request.signal, (row) => {
      const key = keyOf(row.slice(0, width), keyModes);
      if (differing.has(key)) {
        targetOf.set(key, row);
      } else if (
        (hashes.get(key) ?? MATCHED) !== MATCHED &&
        onlyTargetRows.length < wantOnlyTarget
      ) {
        onlyTargetRows.push(row);
      }
      return targetOf.size === differing.size && onlyTargetRows.length === wantOnlyTarget;
    });
  }
  const differentRows = [...differing].flatMap(([key, source]) => {
    const target = targetOf.get(key);
    // A row changed between the two reads of the target: nothing to show for it.
    return target === undefined ? [] : [{ source, target }];
  });
  return {
    same,
    different,
    onlySource,
    onlyTarget,
    differentRows,
    onlySourceRows,
    onlyTargetRows,
    durationMs: Date.now() - started,
  };
}

/** Streams every row of the columns; `visit` returns true when it needs no more. */
async function readRows(
  side: CompareTable,
  columns: readonly string[],
  signal: AbortSignal | undefined,
  visit: (row: readonly CellValue[], count: number) => boolean | undefined,
): Promise<void> {
  const sql = `SELECT ${columns.map((column) => side.dialect.quoteIdentifier(column)).join(', ')} FROM ${side.dialect.quoteTable(side.table)}`;
  if (signal?.aborted === true) {
    throw new DbError('cancelled', 'The comparison was cancelled');
  }
  const session = await side.session();
  // A slow server may not send a row for a long time: stopping must reach it too.
  const stop = (): void => {
    void session.cancel();
  };
  signal?.addEventListener('abort', stop);
  try {
    await stream(session, sql, side, signal, visit);
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

async function stream(
  session: Session,
  sql: string,
  side: CompareTable,
  signal: AbortSignal | undefined,
  visit: (row: readonly CellValue[], count: number) => boolean | undefined,
): Promise<void> {
  let count = 0;
  rows: for await (const event of session.execute(sql)) {
    if (event.kind !== 'rows') {
      continue;
    }
    for (const row of event.rows) {
      if (signal?.aborted === true) {
        throw new DbError('cancelled', 'The comparison was cancelled');
      }
      count += 1;
      if (count > ROW_LIMIT) {
        throw new DbError(
          'unsupported',
          `${side.table.name} has more than ${ROW_LIMIT.toLocaleString('en')} rows: too many to compare`,
        );
      }
      if (visit(row, count) === true) {
        break rows;
      }
    }
  }
}

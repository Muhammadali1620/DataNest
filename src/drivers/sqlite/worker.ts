// Runs in a worker_thread: node:sqlite is synchronous, so queries must not block
// the extension host (ARCHITECTURE.md §7, D5). Bundled to dist/drivers/sqlite-worker.js.

import { DatabaseSync } from 'node:sqlite';
import { parentPort } from 'node:worker_threads';
import type { ResultColumn } from '../driver';
import { toWireError } from './errors';
import { blobsOf } from './blobs';
import type { HostToWorker, WorkerToHost } from './protocol';
import { toCellValue } from './values';
import type { CellValue } from '../../shared/cell-value';

/** Rows travel to the host in batches of this size. */
export const ROW_BATCH_SIZE = 200;

const port = parentPort;
if (!port) {
  throw new Error('The SQLite worker must be started as a worker thread');
}

let db: DatabaseSync | undefined;

function postRows(id: number, rows: CellValue[][]): void {
  const blobs = blobsOf(rows);
  post(blobs.length === 0 ? { t: 'rows', id, rows } : { t: 'rows', id, rows, blobs });
}

function post(message: WorkerToHost): void {
  // port is checked above; narrow again for the closure.
  parentPort?.postMessage(message);
}

function open(file: string, readOnly: boolean): void {
  try {
    // A read-only handle cannot be turned writable from SQL, unlike PRAGMA query_only.
    db = new DatabaseSync(file, { readOnly });
    post({ t: 'opened' });
  } catch (error) {
    post({ t: 'open-error', error: toWireError(error) });
  }
}

/** The slice of node:sqlite's column descriptors the worker reads. */
interface ColumnLike {
  readonly name?: string | null;
  readonly type?: string | null;
}

function exec(message: Extract<HostToWorker, { t: 'exec' }>): void {
  const { id, sql } = message;
  const params = message.params ?? [];
  const rowLimit = message.rowLimit ?? Number.POSITIVE_INFINITY;
  if (!db) {
    post({ t: 'error', id, error: { code: 'internal', message: 'The database is not open' } });
    return;
  }
  try {
    const statement = db.prepare(sql);
    const described: ColumnLike[] = statement.columns();
    if (described.length === 0) {
      // No result columns: INSERT/UPDATE/DDL/…
      const result = statement.run(...params);
      post({ t: 'done', id, affectedRows: Number(result.changes) });
      return;
    }
    // Integers arrive as bigint so they are never silently rounded.
    statement.setReadBigInts(true);
    // Rows as arrays keep columns that share a name (`SELECT a.id, b.id`) apart;
    // an object keyed by name would keep only the last one. Older runtimes lack
    // the switch and fall back to objects.
    const asArrays = typeof statement.setReturnArrays === 'function';
    if (asArrays) {
      statement.setReturnArrays(true);
    }
    const names = described.map((column, index) => column.name ?? `column${index + 1}`);
    const columns: ResultColumn[] = described.map((column, index) => {
      const name = names[index] ?? `column${index + 1}`;
      const type = column.type;
      return typeof type === 'string' && type !== ''
        ? { name, dataType: type.toLowerCase() }
        : { name };
    });
    post({ t: 'columns', id, columns });
    let batch: CellValue[][] = [];
    let count = 0;
    for (const row of statement.iterate(...params)) {
      if (count >= rowLimit) {
        // The iterator is simply abandoned: unlike a server, nothing keeps running.
        break;
      }
      count += 1;
      if (asArrays) {
        batch.push((row as unknown as unknown[]).map((value) => toCellValue(value)));
      } else {
        const record = row as Record<string, unknown>;
        batch.push(names.map((name) => toCellValue(record[name])));
      }
      if (batch.length >= ROW_BATCH_SIZE) {
        postRows(id, batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      postRows(id, batch);
    }
    post({ t: 'done', id });
  } catch (error) {
    post({ t: 'error', id, error: toWireError(error) });
  }
}

port.on('message', (raw: HostToWorker) => {
  switch (raw.t) {
    case 'open':
      open(raw.file, raw.readOnly === true);
      return;
    case 'exec':
      exec(raw);
      return;
  }
});

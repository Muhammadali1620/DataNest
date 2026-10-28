// Messages between the SQLite session (extension host) and its worker. Everything
// here must survive structured clone: plain objects, numbers, strings, Uint8Array.

import type { CellValue } from '../../shared/cell-value';
import type { ResultColumn } from '../driver';
import type { WireError } from './errors';

/** Values a parameterized worker query may bind (metadata lookups only). */
export type SqliteParam = null | string | number;

export type HostToWorker =
  | { readonly t: 'open'; readonly file: string; readonly readOnly?: boolean }
  | {
      readonly t: 'exec';
      readonly id: number;
      readonly sql: string;
      readonly params?: readonly SqliteParam[];
      readonly rowLimit?: number;
    };

/** Bytes of the binary cell at `[row][column]` of a rows message. */
export interface WireBlob {
  readonly row: number;
  readonly column: number;
  readonly bytes: Uint8Array;
}

export type WorkerToHost =
  | { readonly t: 'opened' }
  | { readonly t: 'open-error'; readonly error: WireError }
  | { readonly t: 'columns'; readonly id: number; readonly columns: readonly ResultColumn[] }
  | {
      readonly t: 'rows';
      readonly id: number;
      readonly rows: readonly (readonly CellValue[])[];
      /**
       * Full bytes of binary cells, which cross the thread boundary as copies, so the
       * host can attach them to its own cell objects (shared/binary-bytes.ts).
       */
      readonly blobs?: readonly WireBlob[];
    }
  | {
      readonly t: 'done';
      readonly id: number;
      readonly affectedRows?: number;
      /** A transaction is open after the statement; absent where SQLite cannot say. */
      readonly tx?: boolean;
    }
  | { readonly t: 'error'; readonly id: number; readonly error: WireError; readonly tx?: boolean };

// The worker reads rows on another thread, where the bytes retained for a binary cell
// (shared/binary-bytes.ts) would be lost with the structured clone. They travel next
// to the rows and are attached to the host's own cell objects on arrival.

import { retainBytes, retainedBytes } from '../../shared/binary-bytes';
import type { CellValue } from '../../shared/cell-value';
import type { WireBlob } from './protocol';

/** The full bytes of the binary cells of a batch, which the cells themselves do not carry. */
export function blobsOf(rows: readonly (readonly CellValue[])[]): WireBlob[] {
  const blobs: WireBlob[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, column) => {
      if (typeof cell === 'object' && cell !== null && cell.kind === 'binary') {
        const bytes = retainedBytes(cell);
        if (bytes !== undefined) {
          blobs.push({ row: rowIndex, column, bytes });
        }
      }
    });
  });
  return blobs;
}

/** Hands the bytes that came with a batch back to the cells they belong to. */
export function attachBlobs(
  rows: readonly (readonly CellValue[])[],
  blobs: readonly WireBlob[] | undefined,
): void {
  for (const { row, column, bytes } of blobs ?? []) {
    const cell = rows[row]?.[column];
    if (typeof cell === 'object' && cell !== null && cell.kind === 'binary') {
      retainBytes(cell, bytes);
    }
  }
}

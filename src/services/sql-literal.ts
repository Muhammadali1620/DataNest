// Values as SQL literals for generated statements: copy as INSERT, dumps, transfers.
// A binary value carries only a short hex preview, so the full bytes the host kept
// are used whenever they are there.

import { DbError } from '../core/errors';
import type { Dialect } from '../drivers/driver';
import { retainedBytes } from '../shared/binary-bytes';
import type { CellValue } from '../shared/cell-value';
import { msg } from '../core/user-message';

/** A literal for the value; a binary one falls back to its preview when the bytes are gone. */
export function literalOf(dialect: Dialect, cell: CellValue): string {
  if (typeof cell === 'object' && cell !== null && cell.kind === 'binary') {
    const bytes = retainedBytes(cell);
    if (bytes !== undefined) {
      return dialect.literal({
        kind: 'binary',
        size: bytes.byteLength,
        preview: Buffer.from(bytes).toString('hex'),
      });
    }
  }
  return dialect.literal(cell);
}

/**
 * Like `literalOf`, but refuses a binary value whose bytes were not kept (larger than
 * the host keeps): a dump must never write a cut value as if it were the whole one.
 */
export function exactLiteralOf(dialect: Dialect, cell: CellValue): string {
  if (
    typeof cell === 'object' &&
    cell !== null &&
    cell.kind === 'binary' &&
    retainedBytes(cell) === undefined &&
    cell.preview.length < cell.size * 2
  ) {
    throw new DbError(
      'unsupported',
      msg('A binary value of {0} bytes is larger than DataNest can copy', cell.size),
    );
  }
  return literalOf(dialect, cell);
}

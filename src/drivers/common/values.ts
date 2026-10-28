// Value helpers shared by drivers; everything here is pure and driver-agnostic.

import { retainBytes } from '../../shared/binary-bytes';
import type { BinaryValue, CellValue } from '../../shared/cell-value';

/** How many bytes of a binary value travel to the UI as a hex preview. */
export const BINARY_PREVIEW_BYTES = 256;

/** BIGINT values that survive a JS number stay numbers; the rest keep exact text. */
export function safeIntOrTag(text: string): CellValue {
  if (/^-?\d{1,15}$/.test(text)) {
    return Number(text);
  }
  const parsed = Number(text);
  if (Number.isSafeInteger(parsed) && String(parsed) === text) {
    return parsed;
  }
  return { kind: 'bigint', text };
}

export function binaryValue(bytes: Uint8Array): BinaryValue {
  const value: BinaryValue = {
    kind: 'binary',
    size: bytes.byteLength,
    preview: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .subarray(0, BINARY_PREVIEW_BYTES)
      .toString('hex'),
  };
  // The value panel shows the whole thing; see shared/binary-bytes.ts.
  retainBytes(value, bytes);
  return value;
}

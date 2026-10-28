import type { BinaryValue } from './cell-value';

// The bytes behind a BinaryValue. Only a short hex preview travels with the cell
// (ARCHITECTURE.md §5), but the value panel needs the whole thing to show an image
// or a full hex dump. The host keeps the bytes next to the cell object, in a
// WeakMap, so they live exactly as long as the result row that owns the cell and
// never leak into messages, copies or exports by accident.

/** The most bytes of one value that are kept and may be sent to the value panel. */
export const MAX_BINARY_VIEW_BYTES = 16 * 1024 * 1024;

const retained = new WeakMap<BinaryValue, Uint8Array>();

/** Remembers the bytes of a value; larger ones are not kept (the preview must do). */
export function retainBytes(value: BinaryValue, bytes: Uint8Array): void {
  if (bytes.byteLength <= MAX_BINARY_VIEW_BYTES) {
    retained.set(value, bytes);
  }
}

/** The full bytes of a value, or undefined when they were too large or are gone. */
export function retainedBytes(value: BinaryValue): Uint8Array | undefined {
  return retained.get(value);
}

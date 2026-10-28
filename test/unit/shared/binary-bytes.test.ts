import { describe, expect, it } from 'vitest';
import {
  MAX_BINARY_VIEW_BYTES,
  retainBytes,
  retainedBytes,
} from '../../../src/shared/binary-bytes';
import type { BinaryValue } from '../../../src/shared/cell-value';

function cell(size: number): BinaryValue {
  return { kind: 'binary', size, preview: '' };
}

describe('retained binary bytes', () => {
  it('returns the bytes kept for a cell', () => {
    const value = cell(3);
    const bytes = new Uint8Array([1, 2, 3]);
    retainBytes(value, bytes);
    expect(retainedBytes(value)).toBe(bytes);
  });

  it('knows nothing about a cell it was never given', () => {
    expect(retainedBytes(cell(3))).toBeUndefined();
  });

  it('keys by cell object, not by what the cell looks like', () => {
    const first = cell(1);
    retainBytes(first, new Uint8Array([9]));
    expect(retainedBytes({ ...first })).toBeUndefined();
  });

  it('keeps a value of exactly the limit and drops anything larger', () => {
    const atLimit = cell(MAX_BINARY_VIEW_BYTES);
    retainBytes(atLimit, new Uint8Array(MAX_BINARY_VIEW_BYTES));
    expect(retainedBytes(atLimit)).toBeDefined();
    const over = cell(MAX_BINARY_VIEW_BYTES + 1);
    retainBytes(over, new Uint8Array(MAX_BINARY_VIEW_BYTES + 1));
    expect(retainedBytes(over)).toBeUndefined();
  });

  it('keeps an empty value', () => {
    const empty = cell(0);
    retainBytes(empty, new Uint8Array());
    expect(retainedBytes(empty)?.byteLength).toBe(0);
  });
});

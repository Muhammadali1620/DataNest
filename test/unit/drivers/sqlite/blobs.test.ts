import { describe, expect, it } from 'vitest';
import { binaryValue } from '../../../../src/drivers/common/values';
import { retainedBytes } from '../../../../src/shared/binary-bytes';
import type { CellValue } from '../../../../src/shared/cell-value';
import { attachBlobs, blobsOf } from '../../../../src/drivers/sqlite/blobs';

describe('sqlite blobs', () => {
  it('lists the bytes of binary cells with their position', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const rows: CellValue[][] = [
      [1, 'a'],
      [2, binaryValue(bytes)],
    ];
    expect(blobsOf(rows)).toEqual([{ row: 1, column: 1, bytes }]);
  });

  it('lists nothing when no cell is binary or none has bytes kept', () => {
    expect(blobsOf([[1, null, 'x', { kind: 'json', text: '{}' }]])).toEqual([]);
    expect(blobsOf([[{ kind: 'binary', size: 1, preview: '00' }]])).toEqual([]);
  });

  it('attaches bytes to the host-side copies of the cells', () => {
    const sent: CellValue[][] = [[7, binaryValue(new Uint8Array([5, 6]))]];
    const blobs = blobsOf(sent);
    // What arrives after the structured clone: equal cells, different objects.
    const received = structuredClone<CellValue[][]>(sent);
    attachBlobs(received, structuredClone(blobs));
    const cell = received[0]?.[1];
    expect(typeof cell === 'object' && cell !== null && cell.kind === 'binary').toBe(true);
    if (typeof cell === 'object' && cell !== null && cell.kind === 'binary') {
      expect(Array.from(retainedBytes(cell) ?? [])).toEqual([5, 6]);
    }
  });

  it('ignores blobs that point at nothing or at a non-binary cell', () => {
    const rows: CellValue[][] = [['text']];
    expect(() => {
      attachBlobs(rows, [
        { row: 0, column: 0, bytes: new Uint8Array() },
        { row: 5, column: 5, bytes: new Uint8Array() },
      ]);
      attachBlobs(rows, undefined);
    }).not.toThrow();
  });
});

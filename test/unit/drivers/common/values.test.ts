import { describe, expect, it } from 'vitest';
import { retainedBytes } from '../../../../src/shared/binary-bytes';
import { BINARY_PREVIEW_BYTES, binaryValue } from '../../../../src/drivers/common/values';

describe('binaryValue', () => {
  it('previews only the first bytes but remembers all of them', () => {
    const bytes = new Uint8Array(BINARY_PREVIEW_BYTES + 100).fill(0xab);
    const value = binaryValue(bytes);
    expect(value.size).toBe(bytes.length);
    expect(value.preview).toHaveLength(BINARY_PREVIEW_BYTES * 2);
    expect(retainedBytes(value)).toBe(bytes);
  });

  it('respects the view of a Buffer slice', () => {
    const whole = Buffer.from([1, 2, 3, 4]);
    const value = binaryValue(whole.subarray(1, 3));
    expect(value.preview).toBe('0203');
    expect(value.size).toBe(2);
  });
});

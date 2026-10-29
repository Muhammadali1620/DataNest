import { describe, expect, it } from 'vitest';
import { formatSize } from '../../../src/shared/byte-size';

describe('formatSize', () => {
  it('shows small sizes exactly and larger ones in units', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(20 * 1024)).toBe('20 KB');
    expect(formatSize(16 * 1024 * 1024)).toBe('16 MB');
    expect(formatSize(5 * 1024 ** 3)).toBe('5 GB');
    expect(formatSize(5000 * 1024 ** 3)).toBe('5000 GB');
  });
});

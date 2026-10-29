import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { exactLiteralOf, literalOf } from '../../../src/services/sql-literal';
import { retainBytes } from '../../../src/shared/binary-bytes';
import type { BinaryValue } from '../../../src/shared/cell-value';

function binary(bytes: number[], previewBytes = bytes.length): BinaryValue {
  return {
    kind: 'binary',
    size: bytes.length,
    preview: Buffer.from(bytes.slice(0, previewBytes)).toString('hex'),
  };
}

describe('literalOf', () => {
  it('uses the full bytes the host kept rather than the preview', () => {
    const value = binary([1, 2, 3, 4], 2);
    retainBytes(value, new Uint8Array([1, 2, 3, 4]));
    expect(literalOf(mysqlDialect, value)).toBe("x'01020304'");
  });

  it('falls back to the preview and handles plain values', () => {
    expect(literalOf(mysqlDialect, binary([1, 2, 3], 2))).toBe("x'0102'");
    expect(literalOf(mysqlDialect, "it's")).toBe("'it''s'");
    expect(literalOf(mysqlDialect, null)).toBe('NULL');
  });
});

describe('exactLiteralOf', () => {
  it('accepts a binary value whose preview is the whole value', () => {
    expect(exactLiteralOf(mysqlDialect, binary([0xff, 0x00]))).toBe("x'ff00'");
  });

  it('refuses a cut binary value whose bytes were not kept', () => {
    expect(() => exactLiteralOf(mysqlDialect, binary([1, 2, 3], 1))).toThrow(/3 bytes/u);
  });

  it('writes other values as literalOf does', () => {
    expect(exactLiteralOf(mysqlDialect, { kind: 'decimal', text: '1.50' })).toBe('1.50');
  });
});

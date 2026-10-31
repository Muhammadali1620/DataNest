import { describe, expect, it } from 'vitest';
import { binaryValue } from '../../../src/drivers/common/values';
import {
  cellFileBytes,
  cellFileExtension,
  fileCellValue,
  fileNameFor,
  MAX_CELL_FILE_BYTES,
} from '../../../src/services/cell-file';
import { MAX_BINARY_VIEW_BYTES, retainedBytes } from '../../../src/shared/binary-bytes';
import type { BinaryValue } from '../../../src/shared/cell-value';

const utf8 = (bytes: Uint8Array | string): string =>
  typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);

describe('cellFileBytes', () => {
  it('gives the whole bytes of a binary value', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
    expect(cellFileBytes(binaryValue(bytes))).toEqual(bytes);
  });

  it('uses a preview that holds every byte, and refuses one that does not', () => {
    expect([
      ...(cellFileBytes({ kind: 'binary', size: 2, preview: 'cafe' }) as Uint8Array),
    ]).toEqual([0xca, 0xfe]);
    expect(cellFileBytes({ kind: 'binary', size: 5000, preview: 'ca' })).toBe('too-large');
  });

  it('writes other values as UTF-8 text, exactly as shown', () => {
    expect(utf8(cellFileBytes('Привет') as Uint8Array)).toBe('Привет');
    expect(utf8(cellFileBytes({ kind: 'json', text: '{"a":1}' }) as Uint8Array)).toBe('{"a":1}');
    expect(utf8(cellFileBytes({ kind: 'decimal', text: '1.50' }) as Uint8Array)).toBe('1.50');
    expect(utf8(cellFileBytes(42) as Uint8Array)).toBe('42');
  });

  it('has nothing to save for NULL or no cell', () => {
    expect(cellFileBytes(null)).toBe('no-value');
    expect(cellFileBytes(undefined)).toBe('no-value');
  });
});

describe('cellFileExtension and fileNameFor', () => {
  it('suggests an extension by the kind of value', () => {
    expect(cellFileExtension({ kind: 'binary', size: 1, preview: '00' })).toBe('bin');
    expect(cellFileExtension({ kind: 'json', text: '{}' })).toBe('json');
    expect(cellFileExtension('x')).toBe('txt');
    expect(cellFileExtension(undefined)).toBe('txt');
  });

  it('makes a file name of a column name', () => {
    expect(fileNameFor('photo')).toBe('photo');
    expect(fileNameFor('a/b\\c:d*?"<>|')).toBe('a_b_c_d______');
    expect(fileNameFor('  ')).toBe('value');
    expect(fileNameFor('..')).toBe('value');
    expect(fileNameFor('x'.repeat(300))).toHaveLength(100);
  });
});

describe('fileCellValue', () => {
  it('keeps the bytes of a file for a binary column', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const loaded = fileCellValue('binary', bytes);
    expect(loaded).toMatchObject({
      ok: true,
      value: { kind: 'binary', size: 3, preview: '010203' },
    });
    expect(loaded.ok && retainedBytes(loaded.value as BinaryValue)).toEqual(bytes);
  });

  it('reads text and JSON, which must be valid for a JSON column', () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(fileCellValue('text', encode('line 1\nline 2'))).toEqual({
      ok: true,
      value: 'line 1\nline 2',
    });
    expect(fileCellValue('json', encode('{"a": [1, 2]}'))).toMatchObject({ ok: true });
    expect(fileCellValue('json', encode('{broken'))).toEqual({ ok: false, error: 'invalid-json' });
  });

  it('refuses text that is not UTF-8, kinds that are typed, and files too large', () => {
    expect(fileCellValue('text', Uint8Array.from([0xc3, 0x28]))).toEqual({
      ok: false,
      error: 'not-text',
    });
    for (const kind of ['integer', 'number', 'date', 'datetime', 'boolean', 'enum'] as const) {
      expect(fileCellValue(kind, Uint8Array.from([0x31]))).toEqual({
        ok: false,
        error: 'read-only-column',
      });
    }
    expect(MAX_CELL_FILE_BYTES).toBe(MAX_BINARY_VIEW_BYTES);
    expect(fileCellValue('binary', new Uint8Array(MAX_CELL_FILE_BYTES + 1))).toEqual({
      ok: false,
      error: 'too-large',
    });
  });
});

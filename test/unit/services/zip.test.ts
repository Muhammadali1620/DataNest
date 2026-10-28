import { describe, expect, it } from 'vitest';
import { crc32, zip } from '../../../src/services/zip';
import { unzip } from '../../helpers/unzip';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('crc32', () => {
  it('matches the standard check values', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('zip', () => {
  it('stores every file so that a reader gets it back unchanged', () => {
    const files = [
      { name: 'a.txt', data: bytes('hello '.repeat(500)) },
      { name: 'dir/b.bin', data: Uint8Array.from({ length: 1000 }, (_, i) => i % 251) },
      { name: 'empty', data: new Uint8Array() },
    ];
    const entries = unzip(zip(files));
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'dir/b.bin', 'empty']);
    entries.forEach((entry, index) => {
      expect(Array.from(entry.data)).toEqual(Array.from(files[index]?.data ?? []));
    });
  });

  it('deflates what shrinks and stores what does not', () => {
    const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 167 + 13) & 0xff);
    const [text, raw] = unzip(
      zip([
        { name: 'text', data: bytes('abc'.repeat(1000)) },
        { name: 'noise', data: noise },
      ]),
    );
    expect(text?.method).toBe(8);
    expect(raw?.method).toBe(0);
  });

  it('marks names as UTF-8 and keeps non-ASCII names intact', () => {
    const [entry] = unzip(zip([{ name: 'Ünï/файл.txt', data: bytes('x') }]));
    expect(entry?.name).toBe('Ünï/файл.txt');
    expect((entry?.flags ?? 0) & 0x0800).toBe(0x0800);
  });

  it('writes a valid empty archive', () => {
    const archive = zip([]);
    expect(archive).toHaveLength(22);
    expect(unzip(archive)).toEqual([]);
  });

  it('refuses more entries than the format can count', () => {
    const many = Array.from({ length: 0xffff }, (_, i) => ({
      name: `f${i}`,
      data: new Uint8Array(),
    }));
    expect(() => zip(many)).toThrow('Too many files');
  });

  it('stamps a date no earlier than 1980', () => {
    const archive = Buffer.from(zip([{ name: 'a', data: bytes('x') }], new Date(1970, 0, 1)));
    const date = archive.readUInt16LE(12);
    expect(date >> 9).toBe(0);
  });
});

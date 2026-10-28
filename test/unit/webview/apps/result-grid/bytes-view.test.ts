import { describe, expect, it } from 'vitest';
import {
  bytesFromBase64,
  bytesFromHex,
  formatSize,
  hexOf,
  hexRows,
  imageMimeOf,
} from '../../../../../webview/src/apps/result-grid/bytes-view';
import { bytesOfText } from '../../../../helpers/bytes';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('hexRows', () => {
  it('lays bytes out sixteen to a row with offsets and ascii', () => {
    const data = Uint8Array.from('Hello, hex world!!'.split('').map((c) => c.charCodeAt(0)));
    const rows = hexRows(data, 0, data.length);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      offset: '00000000',
      hex: '48 65 6c 6c 6f 2c 20 68 65 78 20 77 6f 72 6c 64',
      ascii: 'Hello, hex world',
    });
    expect(rows[1]?.offset).toBe('00000010');
    expect(rows[1]?.ascii).toBe('!!');
  });

  it('pads a short last row so columns line up', () => {
    const [row] = hexRows(bytes(1, 2), 0, 2);
    expect(row?.hex).toHaveLength(47);
    expect(row?.hex.startsWith('01 02')).toBe(true);
  });

  it('shows unprintable bytes as dots', () => {
    expect(hexRows(bytes(0, 0x1f, 0x7f, 0x41, 0xff), 0, 5)[0]?.ascii).toBe('...A.');
  });

  it('starts at an offset and stops at the count', () => {
    const data = new Uint8Array(100).map((_, i) => i);
    const rows = hexRows(data, 32, 20);
    expect(rows.map((row) => row.offset)).toEqual(['00000020', '00000030']);
    expect(rows[1]?.hex.startsWith('30 31 32 33')).toBe(true);
    expect(rows[1]?.hex.trim().split(' ')).toHaveLength(4);
  });

  it('gives nothing for empty data or an offset past the end', () => {
    expect(hexRows(new Uint8Array(), 0, 10)).toEqual([]);
    expect(hexRows(bytes(1), 5, 10)).toEqual([]);
  });
});

describe('byte conversions', () => {
  it('round-trips hex', () => {
    expect(Array.from(bytesFromHex('00ff10'))).toEqual([0, 255, 16]);
    expect(hexOf(bytes(0, 255, 16))).toBe('00ff10');
  });

  it('ignores a dangling hex digit and accepts an empty string', () => {
    expect(Array.from(bytesFromHex('abc'))).toEqual([0xab]);
    expect(bytesFromHex('')).toHaveLength(0);
  });

  it('decodes base64', () => {
    expect(Array.from(bytesFromBase64('AP8Q'))).toEqual([0, 255, 16]);
    expect(bytesFromBase64('')).toHaveLength(0);
  });
});

describe('imageMimeOf', () => {
  it('recognizes the formats the webview can draw', () => {
    expect(imageMimeOf(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(imageMimeOf(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(imageMimeOf(bytesOfText('GIF89a....'))).toBe('image/gif');
    expect(imageMimeOf(bytesOfText('GIF87a....'))).toBe('image/gif');
    expect(imageMimeOf(bytesOfText('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('recognizes a bitmap only with a real header, not just "BM"', () => {
    const bmp = new Uint8Array(30);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;
    bmp[14] = 40;
    bmp[16] = 1;
    expect(imageMimeOf(bmp)).toBe('image/bmp');
    expect(imageMimeOf(bytesOfText('BM is a text'))).toBeUndefined();
    expect(imageMimeOf(bytes(0x42, 0x4d))).toBeUndefined();
  });

  it('refuses a RIFF file that is not WebP and a truncated signature', () => {
    expect(imageMimeOf(bytesOfText('RIFF\0\0\0\0WAVEfmt '))).toBeUndefined();
    expect(imageMimeOf(bytes(0x89, 0x50))).toBeUndefined();
    expect(imageMimeOf(new Uint8Array())).toBeUndefined();
  });

  it('never calls SVG or plain text an image', () => {
    expect(imageMimeOf(bytesOfText('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(imageMimeOf(bytesOfText('GIF text'))).toBeUndefined();
  });
});

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

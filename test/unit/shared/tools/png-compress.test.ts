import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../../../../src/shared/tools/bytes';
import {
  crc32,
  encodeIndexedPng,
  paletteToPixels,
  quantize,
} from '../../../../src/shared/tools/png-compress';

const deflate = (bytes: Uint8Array): Promise<Uint8Array> => Promise.resolve(deflateSync(bytes));

function gradient(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = (x * 255) / (width - 1);
      data[at + 1] = (y * 255) / (height - 1);
      data[at + 2] = 128;
      data[at + 3] = 255;
    }
  }
  return data;
}

interface Chunk {
  type: string;
  body: Uint8Array;
}

function chunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length), `crc of ${type}`).toBe(
      crc32(png.subarray(at + 4, at + 8 + length)),
    );
    out.push({ type, body });
    at += 12 + length;
  }
  return out;
}

/** Reads the palette indices back out of an indexed PNG. */
function indicesOf(png: Uint8Array): {
  width: number;
  height: number;
  depth: number;
  indices: number[];
  list: Chunk[];
} {
  const list = chunks(png);
  const header = list[0]?.body ?? new Uint8Array(13);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const depth = header[8] ?? 8;
  const raw = inflateSync(list.find((c) => c.type === 'IDAT')?.body ?? new Uint8Array(0));
  const rowBytes = Math.ceil((width * depth) / 8);
  const indices: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = x * depth;
      const byte = raw[y * (rowBytes + 1) + 1 + (bit >>> 3)] ?? 0;
      indices.push((byte >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1));
    }
  }
  return { width, height, depth, indices, list };
}

describe('crc32', () => {
  it('matches the known check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('bytes', () => {
  it('round-trips Base64, also past one chunk', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });
});

describe('quantize', () => {
  it('keeps the exact colours when there are few', () => {
    const data = Uint8ClampedArray.from([
      255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
    ]);
    const palette = quantize(data, 16);
    expect(palette.colours.length / 4).toBe(3);
    expect([...paletteToPixels(palette)]).toEqual([...data]);
  });

  it('reduces to the limit and stays close to the picture', () => {
    const data = gradient(32, 32);
    for (const limit of [2, 8, 64, 256]) {
      const palette = quantize(data, limit);
      expect(palette.colours.length / 4).toBeLessThanOrEqual(limit);
      expect(palette.indices).toHaveLength(32 * 32);
      expect(Math.max(...palette.indices)).toBeLessThan(palette.colours.length / 4);
    }
    const out = paletteToPixels(quantize(data, 256));
    let error = 0;
    for (let i = 0; i < data.length; i++) {
      error += Math.abs((data[i] ?? 0) - (out[i] ?? 0));
    }
    expect(error / data.length).toBeLessThan(8);
  });

  it('gives more colours a closer picture', () => {
    const data = gradient(32, 32);
    const distance = (limit: number): number => {
      const out = paletteToPixels(quantize(data, limit));
      return data.reduce((sum, value, i) => sum + Math.abs(value - (out[i] ?? 0)), 0);
    };
    expect(distance(8)).toBeGreaterThan(distance(64));
    expect(distance(64)).toBeGreaterThan(distance(256));
  });

  it('treats every fully transparent pixel as one colour and keeps partial alpha', () => {
    const data = Uint8ClampedArray.from([1, 2, 3, 0, 9, 9, 9, 0, 10, 20, 30, 128, 10, 20, 30, 255]);
    const palette = quantize(data, 8);
    expect(palette.colours.length / 4).toBe(3);
    expect(palette.indices[0]).toBe(palette.indices[1]);
    const out = paletteToPixels(palette);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(out[11]).toBe(128);
  });

  it('copes with an empty picture and clamps the limit', () => {
    expect(quantize(new Uint8ClampedArray(0), 16).indices).toHaveLength(0);
    expect(quantize(gradient(4, 4), 1).colours.length / 4).toBeLessThanOrEqual(2);
    expect(quantize(gradient(4, 4), 9999).colours.length / 4).toBeLessThanOrEqual(256);
  });
});

describe('encodeIndexedPng', () => {
  it('writes a PNG that reads back to the same indices at every bit depth', async () => {
    for (const [colours, depth] of [
      [2, 1],
      [4, 2],
      [16, 4],
      [200, 8],
    ] as const) {
      const width = 13;
      const height = 7;
      const data = gradient(width, height);
      const palette = quantize(data, colours);
      const png = await encodeIndexedPng(width, height, palette, deflate);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const read = indicesOf(png);
      expect(read.width).toBe(width);
      expect(read.height).toBe(height);
      expect(read.depth, `${colours} colours`).toBe(
        palette.colours.length / 4 <= 2
          ? 1
          : palette.colours.length / 4 <= 4
            ? 2
            : palette.colours.length / 4 <= 16
              ? 4
              : 8,
      );
      expect(depth).toBeGreaterThan(0);
      expect(read.indices).toEqual([...palette.indices]);
      expect(read.list.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
      expect(read.list[1]?.body).toHaveLength((palette.colours.length / 4) * 3);
    }
  });

  it('adds a transparency chunk only as long as it needs to be', async () => {
    const data = Uint8ClampedArray.from([5, 5, 5, 0, 200, 0, 0, 255, 0, 0, 200, 255]);
    const palette = quantize(data, 8);
    const png = await encodeIndexedPng(3, 1, palette, deflate);
    const list = chunks(png);
    const trns = list.find((c) => c.type === 'tRNS');
    expect(trns).toBeDefined();
    expect(trns?.body.length).toBeLessThan(palette.colours.length / 4 + 1);
    const opaque = await encodeIndexedPng(
      1,
      1,
      quantize(Uint8ClampedArray.from([1, 2, 3, 255]), 2),
      deflate,
    );
    expect(chunks(opaque).some((c) => c.type === 'tRNS')).toBe(false);
  });

  it('is smaller than the raw pixels for a flat picture', async () => {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4).fill(200);
    const png = await encodeIndexedPng(width, height, quantize(data, 256), deflate);
    expect(png.length).toBeLessThan(200);
  });
});

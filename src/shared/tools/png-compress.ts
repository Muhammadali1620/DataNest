// Shrinking a picture without leaving the page: reduce the colours to a palette by median
// cut and write an indexed PNG (smaller bit depth when the palette is small). Deflating is
// handed in, so the page uses CompressionStream and the tests use zlib.

export interface Palette {
  /** RGBA, four numbers a colour. */
  readonly colours: Uint8Array;
  readonly indices: Uint8Array;
}

interface Entry {
  key: number;
  count: number;
  c: [number, number, number, number];
}

/** At most `maxColours` (2–256) colours for the RGBA pixels, with each pixel's index. */
export function quantize(data: ArrayLike<number>, maxColours: number): Palette {
  const limit = Math.max(2, Math.min(256, Math.floor(maxColours)));
  const count = Math.floor(data.length / 4);
  const seen = new Map<number, Entry>();
  const keys = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    const a = data[i * 4 + 3] ?? 0;
    // A fully transparent pixel has no colour worth keeping apart.
    const key = a === 0 ? 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    keys[i] = key;
    const entry = seen.get(key);
    if (entry === undefined) {
      seen.set(key, { key, count: 1, c: a === 0 ? [0, 0, 0, 0] : [r, g, b, a] });
    } else {
      entry.count++;
    }
  }
  let boxes: Entry[][] = [[...seen.values()]];
  while (boxes.length < limit) {
    let widest = -1;
    let widestRange = 0;
    let channel = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) {
        return;
      }
      for (let c = 0; c < 4; c++) {
        let low = 255;
        let high = 0;
        for (const entry of box) {
          low = Math.min(low, entry.c[c] ?? 0);
          high = Math.max(high, entry.c[c] ?? 0);
        }
        // Weigh by population so a big flat area is not split before a busy one.
        const range = (high - low) * Math.log2(box.length + 1);
        if (range > widestRange) {
          widestRange = range;
          widest = index;
          channel = c;
        }
      }
    });
    const chosen = boxes[widest];
    if (chosen === undefined) {
      break;
    }
    chosen.sort((a, b) => (a.c[channel] ?? 0) - (b.c[channel] ?? 0));
    const total = chosen.reduce((sum, entry) => sum + entry.count, 0);
    let running = 0;
    let cut = 1;
    for (let i = 0; i < chosen.length - 1; i++) {
      running += chosen[i]?.count ?? 0;
      cut = i + 1;
      if (running * 2 >= total) {
        break;
      }
    }
    boxes = [
      ...boxes.slice(0, widest),
      chosen.slice(0, cut),
      chosen.slice(cut),
      ...boxes.slice(widest + 1),
    ];
  }
  const colours = new Uint8Array(boxes.length * 4);
  const indexOfKey = new Map<number, number>();
  boxes.forEach((box, index) => {
    const total = box.reduce((sum, entry) => sum + entry.count, 0);
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (const entry of box) {
        sum += (entry.c[c] ?? 0) * entry.count;
      }
      colours[index * 4 + c] = Math.round(sum / total);
    }
    for (const entry of box) {
      indexOfKey.set(entry.key, index);
    }
  });
  const indices = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    indices[i] = indexOfKey.get(keys[i] ?? 0) ?? 0;
  }
  return { colours, indices };
}

/** The palette's colours as RGBA pixels again, to look at what the reduction did. */
export function paletteToPixels(palette: Palette): Uint8ClampedArray {
  const out = new Uint8ClampedArray(palette.indices.length * 4);
  palette.indices.forEach((index, i) => {
    out.set(palette.colours.subarray(index * 4, index * 4 + 4), i * 4);
  });
  return out;
}

// ---- PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array>;

export async function encodeIndexedPng(
  width: number,
  height: number,
  palette: Palette,
  deflate: Deflate,
): Promise<Uint8Array> {
  const size = palette.colours.length / 4;
  const depth = size <= 2 ? 1 : size <= 4 ? 2 : size <= 16 ? 4 : 8;
  const rowBytes = Math.ceil((width * depth) / 8);
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (rowBytes + 1);
    raw[start] = 0; // filter: none, the right choice for indexed pixels
    for (let x = 0; x < width; x++) {
      const index = palette.indices[y * width + x] ?? 0;
      const bit = x * depth;
      const at = start + 1 + (bit >>> 3);
      raw[at] = (raw[at] ?? 0) | (index << (8 - depth - (bit & 7)));
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = depth;
  header[9] = 3;
  const plte = new Uint8Array(size * 3);
  const alpha = new Uint8Array(size);
  let lastAlpha = -1;
  for (let i = 0; i < size; i++) {
    plte.set(palette.colours.subarray(i * 4, i * 4 + 3), i * 3);
    alpha[i] = palette.colours[i * 4 + 3] ?? 255;
    if (alpha[i] !== 255) {
      lastAlpha = i;
    }
  }
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', plte),
    ...(lastAlpha >= 0 ? [chunk('tRNS', alpha.subarray(0, lastAlpha + 1))] : []),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

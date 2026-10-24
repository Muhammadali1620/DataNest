// @ts-check
// Draws the extension icon into resources/icon.png. Pure JS: the PNG is encoded
// with zlib from Node, so there is no native dependency and no binary asset that
// nobody can regenerate. Run it with `npm run icon` after changing the design.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Marketplace shows the icon at 128×128; drawing at 4× keeps the edges smooth. */
export const SIZE = 128;
const SCALE = 4;

/** The mark: a nest holding three eggs, in the project's colours. */
const COLOURS = {
  background: [26, 32, 44], // deep slate, readable on light and dark themes
  nest: [214, 158, 46], // warm straw
  nestDark: [151, 108, 28],
  egg: [237, 242, 247],
};

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * One RGBA pixel buffer, drawn at SCALE and averaged down (supersampling), which
 * is what makes the curves look smooth without any drawing library.
 *
 * @returns {Buffer} RGBA, SIZE × SIZE
 */
export function render() {
  const big = SIZE * SCALE;
  const samples = new Uint8Array(big * big * 4);
  const centre = big / 2;
  const radius = big * 0.46;
  const corner = big * 0.22;

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const index = (y * big + x) * 4;
      let colour = null;
      let alpha = 0;

      // Rounded square background.
      if (insideRoundedSquare(x, y, big, corner)) {
        colour = COLOURS.background;
        alpha = 255;
      }

      // The nest: a thick bowl, open at the top.
      const dx = x - centre;
      const dy = y - centre * 1.12;
      const bowl = Math.hypot(dx, dy * 1.25);
      if (alpha > 0 && bowl < radius * 0.78 && bowl > radius * 0.5 && dy > -radius * 0.12) {
        colour = dy > radius * 0.3 ? COLOURS.nestDark : COLOURS.nest;
      }

      // Three eggs resting in it.
      const eggRadius = radius * 0.19;
      /** @type {{ x: number; y: number }[]} */
      const eggs = [
        { x: centre - radius * 0.3, y: centre * 1.12 - radius * 0.18 },
        { x: centre, y: centre * 1.12 - radius * 0.3 },
        { x: centre + radius * 0.3, y: centre * 1.12 - radius * 0.18 },
      ];
      for (const egg of eggs) {
        if (alpha > 0 && Math.hypot(x - egg.x, (y - egg.y) * 1.15) < eggRadius) {
          colour = COLOURS.egg;
        }
      }

      if (colour !== null) {
        samples[index] = colour[0] ?? 0;
        samples[index + 1] = colour[1] ?? 0;
        samples[index + 2] = colour[2] ?? 0;
        samples[index + 3] = alpha;
      }
    }
  }
  return downsample(samples, big, SCALE);
}

/** @param {number} x @param {number} y @param {number} size @param {number} corner */
function insideRoundedSquare(x, y, size, corner) {
  const left = corner;
  const right = size - corner;
  if (x >= left && x <= right) {
    return y >= 0 && y <= size;
  }
  if (y >= left && y <= right) {
    return x >= 0 && x <= size;
  }
  const cx = x < left ? left : right;
  const cy = y < left ? left : right;
  return Math.hypot(x - cx, y - cy) <= corner;
}

/**
 * @param {Uint8Array} source
 * @param {number} bigSize
 * @param {number} scale
 * @returns {Buffer}
 */
function downsample(source, bigSize, scale) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const index = ((y * scale + sy) * bigSize + (x * scale + sx)) * 4;
          r += source[index] ?? 0;
          g += source[index + 1] ?? 0;
          b += source[index + 2] ?? 0;
          a += source[index + 3] ?? 0;
        }
      }
      const count = scale * scale;
      const target = (y * SIZE + x) * 4;
      out[target] = clamp(Math.round(r / count), 0, 255);
      out[target + 1] = clamp(Math.round(g / count), 0, 255);
      out[target + 2] = clamp(Math.round(b / count), 0, 255);
      out[target + 3] = clamp(Math.round(a / count), 0, 255);
    }
  }
  return out;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

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

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Buffer} rgba */
export function encodePng(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Every row is prefixed with its filter type; 0 means "no filter".
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const target = fileURLToPath(new URL('../resources/icon.png', import.meta.url));
writeFileSync(target, encodePng(render()));
process.stdout.write(`Wrote ${target}\n`);

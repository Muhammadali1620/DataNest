// A QR code encoder written from ISO/IEC 18004: text → segments → data codewords → blocks
// with Reed-Solomon → interleaved bits → modules with the best of the eight masks.

import {
  alignmentPositions,
  blockCount,
  dataCodewords,
  eccPerBlock,
  formatBits,
  functionModules,
  MAX_VERSION,
  MIN_VERSION,
  maskApplies,
  type QrEcc,
  rsDivisor,
  rsRemainder,
  sizeOf,
  totalCodewords,
  versionBits,
} from './tables';

export interface QrCode {
  readonly version: number;
  readonly ecc: QrEcc;
  readonly mask: number;
  readonly size: number;
  /** `modules[y][x]` is true for a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

export interface QrOptions {
  readonly ecc?: QrEcc;
  /** Never pick a smaller version than this one. */
  readonly minVersion?: number;
  /** Force a mask (0–7) instead of the best one; for tests and byte-exact output. */
  readonly mask?: number;
}

export class QrTooLongError extends Error {
  constructor() {
    super('The text does not fit in a QR code at this error-correction level');
    this.name = 'QrTooLongError';
  }
}

type Mode = 'numeric' | 'alphanumeric' | 'byte';

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const MODE_BITS: Readonly<Record<Mode, number>> = {
  numeric: 0b0001,
  alphanumeric: 0b0010,
  byte: 0b0100,
};

export function modeOf(text: string): Mode {
  if (/^[0-9]*$/u.test(text)) {
    return 'numeric';
  }
  return Array.from(text).every((char) => ALPHANUMERIC.includes(char)) ? 'alphanumeric' : 'byte';
}

function countBits(mode: Mode, version: number): number {
  const index = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const table: Readonly<Record<Mode, readonly number[]>> = {
    numeric: [10, 12, 14],
    alphanumeric: [9, 11, 13],
    byte: [8, 16, 16],
  };
  return table[mode][index] ?? 8;
}

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }
}

function payloadBits(text: string, mode: Mode): { buffer: BitBuffer; count: number } {
  const buffer = new BitBuffer();
  if (mode === 'numeric') {
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      buffer.append(Number(chunk), chunk.length * 3 + 1);
    }
    return { buffer, count: text.length };
  }
  if (mode === 'alphanumeric') {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 2) {
      const first = ALPHANUMERIC.indexOf(chars[i] ?? '');
      if (i + 1 < chars.length) {
        buffer.append(first * 45 + ALPHANUMERIC.indexOf(chars[i + 1] ?? ''), 11);
      } else {
        buffer.append(first, 6);
      }
    }
    return { buffer, count: chars.length };
  }
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    buffer.append(byte, 8);
  }
  return { buffer, count: bytes.length };
}

/** Data codewords of the text at a version: header, payload, terminator and the pad bytes. */
function dataOf(text: string, mode: Mode, version: number, ecc: QrEcc): number[] | undefined {
  const { buffer: payload, count } = payloadBits(text, mode);
  const capacity = dataCodewords(version, ecc) * 8;
  const bits = new BitBuffer();
  bits.append(MODE_BITS[mode], 4);
  if (count >= 2 ** countBits(mode, version)) {
    return undefined;
  }
  bits.append(count, countBits(mode, version));
  bits.bits.push(...payload.bits);
  if (bits.length > capacity) {
    return undefined;
  }
  bits.append(0, Math.min(4, capacity - bits.length));
  bits.append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    bits.append(pad, 8);
  }
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) {
      value = (value << 1) | (bits.bits[i + j] ?? 0);
    }
    bytes.push(value);
  }
  return bytes;
}

/** Splits the data into blocks, adds each block's error correction and interleaves them. */
export function interleave(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const blocks = blockCount(version, ecc);
  const eccLength = eccPerBlock(version, ecc);
  const raw = totalCodewords(version);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLength);
  const parts: number[][] = [];
  let offset = 0;
  for (let i = 0; i < blocks; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const check = rsRemainder(block, divisor);
    if (i < shortBlocks) {
      block.push(0);
    }
    parts.push([...block, ...check]);
  }
  const result: number[] = [];
  for (let i = 0; i < (parts[0]?.length ?? 0); i++) {
    parts.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) {
        result.push(block[i] ?? 0);
      }
    });
  }
  return result;
}

class Grid {
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    const size = sizeOf(version);
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = functionModules(version);
  }

  get size(): number {
    return this.modules.length;
  }

  set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    if (row !== undefined && x >= 0 && x < this.size) {
      row[x] = dark;
    }
  }
}

function drawPatterns(grid: Grid): void {
  const { size, version } = grid;
  for (let i = 0; i < size; i++) {
    grid.set(6, i, i % 2 === 0);
    grid.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        grid.set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((cy, row) => {
    positions.forEach((cx, col) => {
      if (!(
        (row === 0 && col === 0) ||
        (row === 0 && col === last) ||
        (row === last && col === 0)
      )) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    });
  });
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      grid.set(a, b, dark);
      grid.set(b, a, dark);
    }
  }
}

function drawFormat(grid: Grid, ecc: QrEcc, mask: number): void {
  const { size } = grid;
  const bits = formatBits(ecc, mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) {
    grid.set(8, i, bit(i));
  }
  grid.set(8, 7, bit(6));
  grid.set(8, 8, bit(7));
  grid.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) {
    grid.set(14 - i, 8, bit(i));
  }
  for (let i = 0; i < 8; i++) {
    grid.set(size - 1 - i, 8, bit(i));
  }
  for (let i = 8; i < 15; i++) {
    grid.set(8, size - 15 + i, bit(i));
  }
  grid.set(8, size - 8, true);
}

function placeCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size } = grid;
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (grid.reserved[y]?.[x] !== true && index < codewords.length * 8) {
          grid.set(x, y, (((codewords[index >>> 3] ?? 0) >>> (7 - (index & 7))) & 1) === 1);
          index++;
        }
      }
    }
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      const row = grid.modules[y];
      if (row !== undefined && grid.reserved[y]?.[x] !== true && maskApplies(mask, x, y)) {
        row[x] = !row[x];
      }
    }
  }
}

/** The penalty of ISO 18004 §7.8.3: long runs, 2×2 blocks, finder-like runs and imbalance. */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  const at = (x: number, y: number): boolean => modules[y]?.[x] === true;
  let score = 0;
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let line = '';
      for (let b = 0; b < size; b++) {
        const dark = horizontal ? at(b, a) : at(a, b);
        line += dark ? '1' : '0';
        if (b > 0) {
          const before = horizontal ? at(b - 1, a) : at(a, b - 1);
          if (dark === before) {
            run++;
            if (run === 5) {
              score += 3;
            } else if (run > 5) {
              score += 1;
            }
          } else {
            run = 1;
          }
        }
      }
      for (const pattern of ['10111010000', '00001011101']) {
        for (let at0 = line.indexOf(pattern); at0 >= 0; at0 = line.indexOf(pattern, at0 + 1)) {
          score += 40;
        }
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      dark += at(x, y) ? 1 : 0;
      if (x + 1 < size && y + 1 < size) {
        const value = at(x, y);
        if (value === at(x + 1, y) && value === at(x, y + 1) && value === at(x + 1, y + 1)) {
          score += 3;
        }
      }
    }
  }
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

function build(codewords: readonly number[], version: number, ecc: QrEcc, mask: number): Grid {
  const grid = new Grid(version);
  drawPatterns(grid);
  placeCodewords(grid, codewords);
  applyMask(grid, mask);
  drawFormat(grid, ecc, mask);
  return grid;
}

/** The data codewords of a text (before the error correction), for tests and tools. */
export function dataCodewordsOf(text: string, version: number, ecc: QrEcc): number[] | undefined {
  return dataOf(text, modeOf(text), version, ecc);
}

export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const ecc = options.ecc ?? 'M';
  const mode = modeOf(text);
  const start = Math.max(MIN_VERSION, Math.min(MAX_VERSION, options.minVersion ?? MIN_VERSION));
  for (let version = start; version <= MAX_VERSION; version++) {
    const data = dataOf(text, mode, version, ecc);
    if (data === undefined) {
      continue;
    }
    const codewords = interleave(data, version, ecc);
    let best = options.mask;
    if (best === undefined) {
      let lowest = Number.POSITIVE_INFINITY;
      for (let mask = 0; mask < 8; mask++) {
        const score = penalty(build(codewords, version, ecc, mask).modules);
        if (score < lowest) {
          lowest = score;
          best = mask;
        }
      }
    }
    const chosen = best ?? 0;
    const grid = build(codewords, version, ecc, chosen);
    return { version, ecc, mask: chosen, size: grid.size, modules: grid.modules };
  }
  throw new QrTooLongError();
}

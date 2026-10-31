// What both halves of the QR code need: the version tables from ISO/IEC 18004, the layout
// of the function patterns, and the Reed-Solomon arithmetic over GF(256).

export type QrEcc = 'L' | 'M' | 'Q' | 'H';
export const QR_ECC_LEVELS: readonly QrEcc[] = ['L', 'M', 'Q', 'H'];

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Index of a level in the tables below. */
export const ECC_INDEX: Readonly<Record<QrEcc, number>> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two bits a level has in the format information. */
export const ECC_FORMAT_BITS: Readonly<Record<QrEcc, number>> = { L: 1, M: 0, Q: 3, H: 2 };

// Error-correction codewords per block and number of blocks, per level, indexed by version
// (index 0 is padding).
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];
const BLOCK_COUNT: readonly (readonly number[])[] = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

export function eccPerBlock(version: number, ecc: QrEcc): number {
  return ECC_PER_BLOCK[ECC_INDEX[ecc]]?.[version] ?? -1;
}

export function blockCount(version: number, ecc: QrEcc): number {
  return BLOCK_COUNT[ECC_INDEX[ecc]]?.[version] ?? -1;
}

export function sizeOf(version: number): number {
  return version * 4 + 17;
}

/** Modules that can carry data or error correction: everything but the function patterns. */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

export function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

/** Codewords that carry the text, after the error correction is taken off. */
export function dataCodewords(version: number, ecc: QrEcc): number {
  return totalCodewords(version) - eccPerBlock(version, ecc) * blockCount(version, ecc);
}

/** Centres of the alignment patterns, in modules, on each axis. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) {
    return [];
  }
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = sizeOf(version) - 7; result.length < count; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

/** Which modules belong to a pattern (finders, timing, alignment, format, version) and carry no data. */
export function functionModules(version: number): boolean[][] {
  const size = sizeOf(version);
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number): void => {
    const row = map[y];
    if (row !== undefined && x >= 0 && x < size) {
      row[x] = true;
    }
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  // The three finders with their separators, and the format information beside them.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        mark(cx + dx, cy + dy);
      }
    }
  }
  for (let i = 0; i < 9; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((cy, row) => {
    positions.forEach((cx, col) => {
      const onFinder =
        (row === 0 && col === 0) || (row === 0 && col === last) || (row === last && col === 0);
      if (!onFinder) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            mark(cx + dx, cy + dy);
          }
        }
      }
    });
  });
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mark(size - 11 + j, i);
        mark(i, size - 11 + j);
      }
    }
  }
  return map;
}

/** The two format-information bytes of a level and a mask, with the BCH code and the XOR mask. */
export function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rest = data;
  for (let i = 0; i < 10; i++) {
    rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
  }
  return ((data << 10) | rest) ^ 0x5412;
}

/** The 18 version-information bits (versions 7 and up). */
export function versionBits(version: number): number {
  let rest = version;
  for (let i = 0; i < 12; i++) {
    rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
  }
  return (version << 12) | rest;
}

export function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

// ---- GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255] ?? 0;
  }
}

export function gfMultiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0);
}

export function gfDivide(a: number, b: number): number {
  if (b === 0) {
    throw new RangeError('Division by zero in GF(256)');
  }
  return a === 0 ? 0 : (EXP[(LOG[a] ?? 0) + 255 - (LOG[b] ?? 0)] ?? 0);
}

export function gfPower(exponent: number): number {
  return EXP[((exponent % 255) + 255) % 255] ?? 0;
}

export function gfInverse(a: number): number {
  return gfDivide(1, a);
}

/** The generator polynomial of the given degree without its leading 1, highest power first. */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < degree) {
        result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
      }
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

/** The error-correction codewords of a block of data. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] = (result[i] ?? 0) ^ gfMultiply(coefficient, factor);
    });
  }
  return result;
}

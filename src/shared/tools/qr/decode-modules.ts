// The second half of reading a QR code: a matrix of modules → format information → unmasked
// codewords → blocks corrected with Reed-Solomon → the text. Finding the matrix in a
// picture is `decode.ts`.

import {
  blockCount,
  eccPerBlock,
  formatBits,
  functionModules,
  gfDivide,
  gfInverse,
  gfMultiply,
  gfPower,
  maskApplies,
  QR_ECC_LEVELS,
  type QrEcc,
  sizeOf,
  totalCodewords,
} from './tables';

export interface QrDecoded {
  readonly text: string;
  readonly version: number;
  readonly ecc: QrEcc;
}

export type Matrix = readonly (readonly boolean[])[];

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function popcount(value: number): number {
  let count = 0;
  for (let rest = value; rest > 0; rest >>>= 1) {
    count += rest & 1;
  }
  return count;
}

// ---- Reed-Solomon decoding (generator roots α^0 … α^(n-1))

function evaluate(poly: readonly number[], x: number): number {
  // lowest power first
  let result = 0;
  for (let i = poly.length - 1; i >= 0; i--) {
    result = gfMultiply(result, x) ^ (poly[i] ?? 0);
  }
  return result;
}

/** Corrects a block (data then check codewords) in place; false when it is beyond repair. */
export function rsCorrect(block: number[], checks: number): boolean {
  const length = block.length;
  const syndromes: number[] = [];
  let clean = true;
  for (let i = 0; i < checks; i++) {
    let value = 0;
    for (const byte of block) {
      value = gfMultiply(value, gfPower(i)) ^ byte;
    }
    syndromes.push(value);
    clean &&= value === 0;
  }
  if (clean) {
    return true;
  }
  // Berlekamp-Massey: the shortest locator polynomial that explains the syndromes.
  const locator = [1];
  let previous = [1];
  let size = 0;
  let shift = 1;
  let lastDiscrepancy = 1;
  for (let n = 0; n < checks; n++) {
    let discrepancy = syndromes[n] ?? 0;
    for (let i = 1; i <= size; i++) {
      discrepancy ^= gfMultiply(locator[i] ?? 0, syndromes[n - i] ?? 0);
    }
    if (discrepancy === 0) {
      shift++;
      continue;
    }
    const before = locator.slice();
    const factor = gfDivide(discrepancy, lastDiscrepancy);
    while (locator.length < previous.length + shift) {
      locator.push(0);
    }
    previous.forEach((coefficient, i) => {
      locator[i + shift] = (locator[i + shift] ?? 0) ^ gfMultiply(factor, coefficient);
    });
    if (2 * size <= n) {
      size = n + 1 - size;
      previous = before;
      lastDiscrepancy = discrepancy;
      shift = 1;
    } else {
      shift++;
    }
  }
  while (locator.length > 1 && locator[locator.length - 1] === 0) {
    locator.pop();
  }
  if (size * 2 > checks || locator.length - 1 !== size) {
    return false;
  }
  // Chien search: the positions whose inverse locator is a root of the polynomial.
  const powers: number[] = [];
  for (let power = 0; power < length; power++) {
    if (evaluate(locator, gfInverse(gfPower(power))) === 0) {
      powers.push(power);
    }
  }
  if (powers.length !== size) {
    return false;
  }
  // Forney: the size of the error at each position.
  const omega: number[] = [];
  for (let i = 0; i < checks; i++) {
    let value = 0;
    for (let j = 0; j <= i; j++) {
      value ^= gfMultiply(locator[j] ?? 0, syndromes[i - j] ?? 0);
    }
    omega.push(value);
  }
  const derivative = locator.map((coefficient, i) => (i % 2 === 1 ? coefficient : 0)).slice(1);
  for (const power of powers) {
    const x = gfPower(power);
    const inverse = gfInverse(x);
    const denominator = evaluate(derivative, inverse);
    if (denominator === 0) {
      return false;
    }
    const magnitude = gfMultiply(x, gfDivide(evaluate(omega, inverse), denominator));
    const index = length - 1 - power;
    block[index] = (block[index] ?? 0) ^ magnitude;
  }
  return syndromesZero(block, checks);
}

function syndromesZero(block: readonly number[], checks: number): boolean {
  for (let i = 0; i < checks; i++) {
    let value = 0;
    for (const byte of block) {
      value = gfMultiply(value, gfPower(i)) ^ byte;
    }
    if (value !== 0) {
      return false;
    }
  }
  return true;
}

// ---- Format information

const FORMAT_FIRST: readonly (readonly [number, number])[] = [
  [8, 0],
  [8, 1],
  [8, 2],
  [8, 3],
  [8, 4],
  [8, 5],
  [8, 7],
  [8, 8],
  [7, 8],
  [5, 8],
  [4, 8],
  [3, 8],
  [2, 8],
  [1, 8],
  [0, 8],
];

const FORMAT_SECOND = (size: number): readonly (readonly [number, number])[] => [
  ...Array.from({ length: 8 }, (_, i) => [size - 1 - i, 8] as const),
  ...Array.from({ length: 7 }, (_, i) => [8, size - 7 + i] as const),
];

function readBits(matrix: Matrix, cells: readonly (readonly [number, number])[]): number {
  return cells.reduce((acc, [x, y], i) => acc | ((matrix[y]?.[x] === true ? 1 : 0) << i), 0);
}

function readFormat(matrix: Matrix): { ecc: QrEcc; mask: number } | undefined {
  const size = matrix.length;
  const reads = [readBits(matrix, FORMAT_FIRST), readBits(matrix, FORMAT_SECOND(size))];
  let best: { ecc: QrEcc; mask: number; distance: number } | undefined;
  for (const ecc of QR_ECC_LEVELS) {
    for (let mask = 0; mask < 8; mask++) {
      const expected = formatBits(ecc, mask);
      const distance = Math.min(...reads.map((read) => popcount(read ^ expected)));
      if (best === undefined || distance < best.distance) {
        best = { ecc, mask, distance };
      }
    }
  }
  // The code corrects three flipped bits; more is a guess.
  return best !== undefined && best.distance <= 3 ? { ecc: best.ecc, mask: best.mask } : undefined;
}

// ---- Codewords

function readCodewords(matrix: Matrix, version: number, mask: number): number[] {
  const size = sizeOf(version);
  const reserved = functionModules(version);
  const total = totalCodewords(version);
  const bytes = new Array<number>(total).fill(0);
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
        if (reserved[y]?.[x] !== true && index < total * 8) {
          const dark = (matrix[y]?.[x] === true) !== maskApplies(mask, x, y);
          if (dark) {
            bytes[index >>> 3] = (bytes[index >>> 3] ?? 0) | (0x80 >>> (index & 7));
          }
          index++;
        }
      }
    }
  }
  return bytes;
}

/** Undoes the interleaving, corrects every block and returns the data codewords in order. */
function dataOf(codewords: readonly number[], version: number, ecc: QrEcc): number[] | undefined {
  const blocks = blockCount(version, ecc);
  const checks = eccPerBlock(version, ecc);
  const raw = totalCodewords(version);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const dataLengths = Array.from(
    { length: blocks },
    (_, i) => shortLength - checks + (i < shortBlocks ? 0 : 1),
  );
  const data: number[][] = dataLengths.map(() => []);
  const check: number[][] = dataLengths.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...dataLengths); i++) {
    for (let j = 0; j < blocks; j++) {
      if (i < (dataLengths[j] ?? 0)) {
        data[j]?.push(codewords[at++] ?? 0);
      }
    }
  }
  for (let i = 0; i < checks; i++) {
    for (let j = 0; j < blocks; j++) {
      check[j]?.push(codewords[at++] ?? 0);
    }
  }
  const result: number[] = [];
  for (let j = 0; j < blocks; j++) {
    const block = [...(data[j] ?? []), ...(check[j] ?? [])];
    if (!rsCorrect(block, checks)) {
      return undefined;
    }
    result.push(...block.slice(0, dataLengths[j]));
  }
  return result;
}

// ---- Segments

class BitReader {
  private position = 0;

  constructor(private readonly bytes: readonly number[]) {}

  get remaining(): number {
    return this.bytes.length * 8 - this.position;
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.position >>> 3] ?? 0;
      value = (value << 1) | ((byte >>> (7 - (this.position & 7))) & 1);
      this.position++;
    }
    return value;
  }
}

function countBits(mode: 'numeric' | 'alphanumeric' | 'byte', version: number): number {
  const index = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] }[mode][index] ?? 8;
}

function bytesToText(bytes: readonly number[]): string {
  const array = Uint8Array.from(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(array);
  } catch {
    return new TextDecoder('iso-8859-1').decode(array);
  }
}

function parse(data: readonly number[], version: number): string | undefined {
  const reader = new BitReader(data);
  let text = '';
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) {
      text += bytesToText(bytes);
      bytes = [];
    }
  };
  while (reader.remaining >= 4) {
    const mode = reader.read(4);
    if (mode === 0) {
      break;
    }
    if (mode === 0b0001) {
      const count = reader.read(countBits('numeric', version));
      for (let left = count; left > 0; left -= 3) {
        const digits = Math.min(3, left);
        const bits = digits * 3 + 1;
        if (reader.remaining < bits) {
          return undefined;
        }
        const value = reader.read(bits);
        if (value >= 10 ** digits) {
          return undefined;
        }
        flush();
        text += String(value).padStart(digits, '0');
      }
    } else if (mode === 0b0010) {
      const count = reader.read(countBits('alphanumeric', version));
      flush();
      for (let left = count; left > 0; left -= 2) {
        if (left >= 2) {
          if (reader.remaining < 11) {
            return undefined;
          }
          const value = reader.read(11);
          if (value >= 45 * 45) {
            return undefined;
          }
          text += (ALPHANUMERIC[Math.floor(value / 45)] ?? '') + (ALPHANUMERIC[value % 45] ?? '');
        } else {
          if (reader.remaining < 6) {
            return undefined;
          }
          text += ALPHANUMERIC[reader.read(6)] ?? '';
        }
      }
    } else if (mode === 0b0100) {
      const count = reader.read(countBits('byte', version));
      if (reader.remaining < count * 8) {
        return undefined;
      }
      for (let i = 0; i < count; i++) {
        bytes.push(reader.read(8));
      }
    } else if (mode === 0b0111) {
      // Character set: the page reads bytes as UTF-8 either way; skip the designator.
      const first = reader.read(8);
      reader.read(first < 0x80 ? 0 : first < 0xc0 ? 8 : 16);
    } else if (mode === 0b0011) {
      reader.read(16);
    } else if (mode === 0b0101) {
      continue;
    } else if (mode === 0b1001) {
      reader.read(8);
    } else {
      // Kanji and the rest: not text the page can show.
      return undefined;
    }
  }
  flush();
  return text;
}

/** Reads a square matrix of modules (true = dark); undefined when it is no readable QR code. */
export function decodeModules(matrix: Matrix): QrDecoded | undefined {
  const size = matrix.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    return undefined;
  }
  const format = readFormat(matrix);
  if (format === undefined) {
    return undefined;
  }
  const codewords = readCodewords(matrix, version, format.mask);
  const data = dataOf(codewords, version, format.ecc);
  if (data === undefined) {
    return undefined;
  }
  const text = parse(data, version);
  return text === undefined ? undefined : { text, version, ecc: format.ecc };
}

/** The same matrix read from the other side, for a code that was mirrored. */
export function transpose(matrix: Matrix): boolean[][] {
  return matrix.map((_, x) => matrix.map((row) => row[x] === true));
}

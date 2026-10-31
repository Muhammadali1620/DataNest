import { describe, expect, it } from 'vitest';
import {
  dataCodewordsOf,
  encodeQr,
  interleave,
  modeOf,
  penalty,
  QrTooLongError,
} from '../../../../src/shared/tools/qr/encode';
import {
  alignmentPositions,
  dataCodewords,
  formatBits,
  functionModules,
  gfDivide,
  gfMultiply,
  gfPower,
  maskApplies,
  QR_ECC_LEVELS,
  rawDataModules,
  rsDivisor,
  rsRemainder,
  sizeOf,
  totalCodewords,
  versionBits,
} from '../../../../src/shared/tools/qr/tables';

const bin = (value: number): string => value.toString(2).padStart(15, '0');

describe('QR tables', () => {
  it('knows the module counts of known versions', () => {
    expect(rawDataModules(1)).toBe(208);
    expect(totalCodewords(1)).toBe(26);
    expect(totalCodewords(7)).toBe(196);
    expect(totalCodewords(40)).toBe(3706);
    expect(sizeOf(1)).toBe(21);
    expect(sizeOf(40)).toBe(177);
  });

  it('puts the alignment patterns where the standard does', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });

  it('counts the data modules the function patterns leave', () => {
    for (const version of [1, 2, 6, 7, 14, 21, 32, 40]) {
      const reserved = functionModules(version);
      const free = reserved.flat().filter((cell) => !cell).length;
      expect(free, `version ${version}`).toBe(rawDataModules(version));
    }
  });

  it('writes the format information of the standard (table C.1)', () => {
    expect(bin(formatBits('L', 0))).toBe('111011111000100');
    expect(bin(formatBits('L', 1))).toBe('111001011110011');
    expect(bin(formatBits('M', 0))).toBe('101010000010010');
    expect(bin(formatBits('Q', 0))).toBe('011010101011111');
    expect(bin(formatBits('H', 0))).toBe('001011010001001');
  });

  it('writes the version information of the standard (table D.1)', () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(40)).toBe(0x28c69);
  });

  it('has the eight masks of the standard', () => {
    expect(maskApplies(0, 0, 0)).toBe(true);
    expect(maskApplies(1, 5, 4)).toBe(true);
    expect(maskApplies(2, 6, 1)).toBe(true);
    expect(maskApplies(3, 2, 1)).toBe(true);
    expect(maskApplies(4, 0, 0)).toBe(true);
    expect(maskApplies(5, 0, 7)).toBe(true);
    expect(maskApplies(6, 3, 3)).toBe(false);
    expect(maskApplies(7, 1, 1)).toBe(false);
  });
});

describe('GF(256) and Reed-Solomon', () => {
  it('multiplies and divides as a field', () => {
    expect(gfMultiply(0, 77)).toBe(0);
    expect(gfMultiply(2, 128)).toBe(0x1d);
    expect(gfPower(8)).toBe(0x1d);
    for (const a of [1, 2, 3, 29, 200, 255]) {
      for (const b of [1, 5, 77, 254]) {
        expect(gfDivide(gfMultiply(a, b), b)).toBe(a);
      }
    }
    expect(() => gfDivide(1, 0)).toThrow(RangeError);
  });

  it('builds the generator of degree 10 from the standard', () => {
    // x^10 + 216x^9 + 194x^8 + 159x^7 + 111x^6 + 199x^5 + 94x^4 + 95x^3 + 113x^2 + 157x + 193
    expect(rsDivisor(10)).toEqual([216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
  });

  it('gives the error correction of the standard\'s example "01234567" (1-M)', () => {
    const data = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]);
  });
});

describe('QR data', () => {
  it('picks the densest mode', () => {
    expect(modeOf('')).toBe('numeric');
    expect(modeOf('0123456789')).toBe('numeric');
    expect(modeOf('HELLO WORLD $%*+-./:')).toBe('alphanumeric');
    expect(modeOf('hello')).toBe('byte');
    expect(modeOf('Привет')).toBe('byte');
  });

  it('encodes "01234567" as the standard shows (1-M)', () => {
    expect(dataCodewordsOf('01234567', 1, 'M')).toEqual([
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ]);
  });

  it('encodes "HELLO WORLD" and its error correction (1-M)', () => {
    const data = dataCodewordsOf('HELLO WORLD', 1, 'M');
    expect(data).toEqual([
      0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ]);
    expect(interleave(data ?? [], 1, 'M').slice(16)).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });

  it('holds the capacities of the standard at the extremes', () => {
    const fits = (text: string, version: number, ecc: 'L' | 'M' | 'Q' | 'H'): boolean =>
      dataCodewordsOf(text, version, ecc) !== undefined;
    expect(fits('1'.repeat(41), 1, 'L')).toBe(true);
    expect(fits('1'.repeat(42), 1, 'L')).toBe(false);
    expect(fits('A'.repeat(25), 1, 'L')).toBe(true);
    expect(fits('A'.repeat(26), 1, 'L')).toBe(false);
    expect(fits('a'.repeat(17), 1, 'L')).toBe(true);
    expect(fits('a'.repeat(18), 1, 'L')).toBe(false);
    expect(fits('1'.repeat(17), 1, 'H')).toBe(true);
    expect(fits('1'.repeat(18), 1, 'H')).toBe(false);
    expect(fits('1'.repeat(7089), 40, 'L')).toBe(true);
    expect(fits('1'.repeat(7090), 40, 'L')).toBe(false);
    expect(fits('A'.repeat(4296), 40, 'L')).toBe(true);
    expect(fits('a'.repeat(2953), 40, 'L')).toBe(true);
    expect(fits('a'.repeat(2954), 40, 'L')).toBe(false);
    expect(fits('a'.repeat(1273), 40, 'H')).toBe(true);
    expect(fits('a'.repeat(1274), 40, 'H')).toBe(false);
  });

  it('has the standard data capacity in codewords', () => {
    expect(dataCodewords(1, 'L')).toBe(19);
    expect(dataCodewords(1, 'M')).toBe(16);
    expect(dataCodewords(1, 'Q')).toBe(13);
    expect(dataCodewords(1, 'H')).toBe(9);
    expect(dataCodewords(40, 'L')).toBe(2956);
    expect(dataCodewords(40, 'H')).toBe(1276);
  });
});

describe('encodeQr', () => {
  it('draws the finders, the timing and the dark module', () => {
    const code = encodeQr('HELLO WORLD', { ecc: 'M', mask: 0 });
    expect(code.version).toBe(1);
    expect(code.size).toBe(21);
    const at = (x: number, y: number): boolean => code.modules[y]?.[x] === true;
    // finder rings at three corners
    for (const [ox, oy] of [
      [0, 0],
      [14, 0],
      [0, 14],
    ] as const) {
      expect(at(ox, oy)).toBe(true);
      expect(at(ox + 6, oy + 6)).toBe(true);
      expect(at(ox + 1, oy + 1)).toBe(false);
      expect(at(ox + 3, oy + 3)).toBe(true);
    }
    expect(at(14, 14)).toBe(code.modules[14]?.[14]);
    expect([8, 9, 10, 11, 12].map((i) => at(i, 6))).toEqual([true, false, true, false, true]);
    expect(at(8, 13)).toBe(true); // the dark module
  });

  it('writes the format bits of the chosen mask in both places', () => {
    const code = encodeQr('HELLO WORLD', { ecc: 'M', mask: 0 });
    const bits = formatBits('M', 0);
    const read = (cells: readonly (readonly [number, number])[]): number =>
      cells.reduce((acc, [x, y], i) => acc | ((code.modules[y]?.[x] === true ? 1 : 0) << i), 0);
    const first = read([
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
    ]);
    expect(first).toBe(bits);
    const second = read([
      [20, 8],
      [19, 8],
      [18, 8],
      [17, 8],
      [16, 8],
      [15, 8],
      [14, 8],
      [13, 8],
      [8, 14],
      [8, 15],
      [8, 16],
      [8, 17],
      [8, 18],
      [8, 19],
      [8, 20],
    ]);
    expect(second).toBe(bits);
  });

  it('chooses the mask with the lowest penalty', () => {
    const best = encodeQr('https://example.com/a?b=c', { ecc: 'Q' });
    const scores = Array.from({ length: 8 }, (_, mask) =>
      penalty(encodeQr('https://example.com/a?b=c', { ecc: 'Q', mask }).modules),
    );
    expect(scores[best.mask]).toBe(Math.min(...scores));
  });

  it('grows the version with the text and respects the minimum', () => {
    expect(encodeQr('1').version).toBe(1);
    expect(encodeQr('a'.repeat(100), { ecc: 'M' }).version).toBe(6);
    expect(encodeQr('a', { minVersion: 5 }).version).toBe(5);
    expect(encodeQr('a'.repeat(2953), { ecc: 'L' }).version).toBe(40);
  });

  it('draws version information from version 7 on', () => {
    const code = encodeQr('a'.repeat(160), { ecc: 'L' });
    expect(code.version).toBeGreaterThanOrEqual(7);
    const bits = versionBits(code.version);
    const { size } = code;
    for (let i = 0; i < 18; i++) {
      const expected = ((bits >>> i) & 1) === 1;
      expect(code.modules[Math.floor(i / 3)]?.[size - 11 + (i % 3)]).toBe(expected);
      expect(code.modules[size - 11 + (i % 3)]?.[Math.floor(i / 3)]).toBe(expected);
    }
  });

  it('refuses a text that cannot fit', () => {
    expect(() => encodeQr('a'.repeat(3000), { ecc: 'L' })).toThrow(QrTooLongError);
    expect(() => encodeQr('1'.repeat(7090), { ecc: 'L' })).toThrow(QrTooLongError);
  });

  it('encodes every level and non-ASCII text', () => {
    for (const ecc of QR_ECC_LEVELS) {
      const code = encodeQr('Привет, мир ✓', { ecc });
      expect(code.ecc).toBe(ecc);
      expect(code.modules).toHaveLength(code.size);
    }
  });

  it('encodes the empty text', () => {
    expect(encodeQr('').version).toBe(1);
  });
});

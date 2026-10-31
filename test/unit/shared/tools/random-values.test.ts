import { describe, expect, it } from 'vitest';
import {
  cryptoSource,
  DEFAULT_PASSWORD,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  password,
  personName,
  pick,
  randomInt,
  type RandomSource,
  uuidV4,
} from '../../../../src/shared/tools/random-values';

/** A source that plays back a fixed list of bytes, then repeats it. */
function fixed(bytes: number[]): RandomSource {
  let at = 0;
  return {
    fill: (target) => {
      for (let i = 0; i < target.length; i += 1) {
        target[i] = bytes[at % bytes.length] ?? 0;
        at += 1;
      }
      return target;
    },
  };
}

describe('randomInt', () => {
  it('stays in range with the real source', () => {
    for (let i = 0; i < 500; i += 1) {
      const value = randomInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it('is zero for a range of one, without asking for bytes', () => {
    const source: RandomSource = {
      fill: () => {
        throw new Error('should not be called');
      },
    };
    expect(randomInt(1, source)).toBe(0);
  });

  it('maps bytes by modulo and rejects the biased top', () => {
    // 0x00000005 % 10 = 5
    expect(randomInt(10, fixed([0, 0, 0, 5]))).toBe(5);
    // 0xFFFFFFFF is above the largest multiple of 10 below 2^32, so it is skipped.
    expect(randomInt(10, fixed([255, 255, 255, 255, 0, 0, 0, 3]))).toBe(3);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 33])('refuses a max of %s', (max) => {
    expect(() => randomInt(max)).toThrow(RangeError);
  });
});

describe('pick', () => {
  it('returns an item and refuses an empty list', () => {
    expect(['a', 'b', 'c']).toContain(pick(['a', 'b', 'c']));
    expect(() => pick([])).toThrow(RangeError);
  });
});

describe('uuidV4', () => {
  it('has the version and variant bits and the usual shape', () => {
    const id = uuidV4(fixed([0xff]));
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidV4()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('differs between calls', () => {
    expect(uuidV4()).not.toBe(uuidV4());
  });
});

describe('password', () => {
  it('has the length and at least one character of every chosen kind', () => {
    for (let i = 0; i < 50; i += 1) {
      const text = password({ ...DEFAULT_PASSWORD, length: 12 }) ?? '';
      expect(text).toHaveLength(12);
      expect(text).toMatch(/[a-z]/u);
      expect(text).toMatch(/[A-Z]/u);
      expect(text).toMatch(/\d/u);
      expect(text).toMatch(/[^A-Za-z0-9]/u);
    }
  });

  it('uses only the chosen kinds', () => {
    const text =
      password({ length: 40, lower: false, upper: false, digits: true, symbols: false }) ?? '';
    expect(text).toMatch(/^[2-9]{40}$/u);
  });

  it('leaves out look-alike characters', () => {
    const text = password({ ...DEFAULT_PASSWORD, length: MAX_PASSWORD_LENGTH }) ?? '';
    expect(text).not.toMatch(/[lIO01]/u);
  });

  it('clamps the length', () => {
    expect(password({ ...DEFAULT_PASSWORD, length: 1 })).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(password({ ...DEFAULT_PASSWORD, length: 9999 })).toHaveLength(MAX_PASSWORD_LENGTH);
    expect(password({ ...DEFAULT_PASSWORD, length: 8.9 })).toHaveLength(8);
  });

  it('is undefined when no kind is chosen', () => {
    expect(
      password({ length: 10, lower: false, upper: false, digits: false, symbols: false }),
    ).toBeUndefined();
  });
});

describe('personName', () => {
  it('is a first and a last name', () => {
    expect(personName()).toMatch(/^\S+ \S+$/u);
    expect(personName(cryptoSource)).not.toBe('');
  });

  it('is deterministic for a fixed source', () => {
    expect(personName(fixed([0, 0, 0, 0]))).toBe(personName(fixed([0, 0, 0, 0])));
  });
});

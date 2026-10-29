import { describe, expect, it } from 'vitest';
import {
  GENERATOR_KINDS,
  generateValue,
  type GeneratorKind,
  isGeneratorKind,
  Random,
} from '../../../../src/services/test-data/generators';
import { GENERATOR_IDS } from '../../../../src/shared/protocols/test-data';
import { parseCellInput } from '../../../../src/shared/cell-input';

function values(kind: GeneratorKind, count = 200, extra = {}): (string | null)[] {
  const random = new Random(42);
  return Array.from({ length: count }, (_, row) => generateValue({ kind, ...extra }, random, row));
}

describe('Random', () => {
  it('gives the same numbers for the same seed and others for another', () => {
    const a = new Random(7);
    const b = new Random(7);
    const c = new Random(8);
    const first = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(first);
  });

  it('stays within its bounds', () => {
    const random = new Random(1);
    for (let i = 0; i < 1000; i += 1) {
      const n = random.next();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
      const k = random.int(-3, 3);
      expect(k).toBeGreaterThanOrEqual(-3);
      expect(k).toBeLessThanOrEqual(3);
    }
  });
});

describe('generators', () => {
  it('are the ones the page offers', () => {
    expect([...GENERATOR_KINDS]).toEqual([...GENERATOR_IDS]);
    expect(isGeneratorKind('email')).toBe(true);
    expect(isGeneratorKind('nope')).toBe(false);
  });

  it('leave a column to the database or NULL', () => {
    expect(values('default', 3)).toEqual([null, null, null]);
    expect(values('null', 2)).toEqual([null, null]);
  });

  it('count in a row from the start', () => {
    expect(values('sequence', 3, { start: 41 })).toEqual(['41', '42', '43']);
  });

  it('write values the column types accept', () => {
    const accepted: readonly (readonly [GeneratorKind, Parameters<typeof parseCellInput>[0]])[] = [
      ['integer', 'integer'],
      ['decimal', 'number'],
      ['price', 'number'],
      ['boolean', 'boolean'],
      ['date', 'date'],
      ['datetime', 'datetime'],
      ['time', 'time'],
      ['json', 'json'],
      ['latitude', 'number'],
      ['longitude', 'number'],
    ];
    for (const [kind, input] of accepted) {
      for (const value of values(kind, 50)) {
        expect(parseCellInput(input, value ?? '').ok, `${kind}: ${value ?? ''}`).toBe(true);
      }
    }
  });

  it('keep integers and decimals within the type', () => {
    for (const value of values('integer', 300, { min: 0, max: 1 })) {
      expect(['0', '1']).toContain(value);
    }
    for (const value of values('decimal', 300, { max: 99, scale: 2 })) {
      expect(value).toMatch(/^\d{1,2}\.\d{2}$/u);
    }
    expect(values('decimal', 50, { scale: 0, max: 9 }).every((v) => /^\d$/u.test(v ?? ''))).toBe(
      true,
    );
  });

  it('make well-formed UUIDs, emails, IPs and URLs', () => {
    for (const value of values('uuid', 100)) {
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
    for (const value of values('email', 100)) {
      expect(value).toMatch(/^[a-z]+\.[a-z]+\d+@example\.com$/u);
    }
    for (const value of values('ip', 100)) {
      expect(
        value
          ?.split('.')
          .map(Number)
          .every((part) => part >= 0 && part <= 255),
      ).toBe(true);
    }
    expect(values('url', 1)[0]).toMatch(/^https:\/\/example\.com\/\w+\/1$/u);
    expect(values('binary', 20).every((v) => /^0x([0-9a-f]{2})+$/u.test(v ?? ''))).toBe(true);
  });

  it('give emails and user names that never repeat', () => {
    expect(new Set(values('email', 500)).size).toBe(500);
    expect(new Set(values('username', 500)).size).toBe(500);
  });

  it('choose from the given values, or NULL when there are none', () => {
    expect(new Set(values('enum', 100, { choices: ['a', 'b'] }))).toEqual(new Set(['a', 'b']));
    expect(values('reference', 2, { choices: [] })).toEqual([null, null]);
    expect(values('status', 50, { choices: ['open'] }).every((v) => v === 'open')).toBe(true);
  });

  it('cut text to the column and pad a fixed-length one', () => {
    expect(values('sentence', 100, { maxLength: 5 }).every((v) => (v ?? '').length <= 5)).toBe(
      true,
    );
    expect(
      values('words', 50, { maxLength: 3, fixedLength: true }).every((v) => v?.length === 3),
    ).toBe(true);
  });

  it('number unique text, keeping the number when the column is short', () => {
    const unique = values('city', 300, { unique: true, maxLength: 8 });
    expect(new Set(unique).size).toBe(300);
    expect(unique.every((v) => (v ?? '').length <= 8)).toBe(true);
    expect(unique[299]?.endsWith('300')).toBe(true);
  });

  it('give the same rows for the same seed', () => {
    expect(values('fullName', 20)).toEqual(values('fullName', 20));
  });
});

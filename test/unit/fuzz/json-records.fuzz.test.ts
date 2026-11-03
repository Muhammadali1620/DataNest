import { describe, expect, it } from 'vitest';
import { JsonRecordParser, type JsonRecord } from '../../../src/services/import/json-parser';
import { pick, pieces, seeded } from '../../helpers/fuzz';

const STRING_PARTS = [
  'a',
  ' ',
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  '"',
  '\\',
  '\n',
  ' ',
  'é',
  '日本',
  '\u{1F600}',
  '\u0000',
];

function recordOf(random: () => number): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const count = 1 + Math.floor(random() * 4);
  for (let index = 0; index < count; index += 1) {
    const key = `k${index}${pieces(random, STRING_PARTS, 2)}`;
    record[key] = pick(random, [
      () => pieces(random, STRING_PARTS, 6),
      () => Math.floor(random() * 1000),
      () => random() < 0.5,
      () => null,
      () => ({ nested: [1, { x: pieces(random, STRING_PARTS, 3) }] }),
      () => [pieces(random, STRING_PARTS, 2)],
    ])();
  }
  return record;
}

function chunks(random: () => number, text: string): string[] {
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(random() * 7);
    parts.push(text.slice(at, at + size));
    at += size;
  }
  return parts;
}

function readAll(parts: readonly string[]): JsonRecord[] {
  const parser = new JsonRecordParser();
  const out: JsonRecord[] = [];
  for (const part of parts) {
    out.push(...parser.push(part));
  }
  out.push(...parser.end());
  return out;
}

describe('JSON records read in parts', () => {
  for (const shape of ['array', 'lines'] as const) {
    it(`give the same records however the ${shape} text is cut`, () => {
      const random = seeded(shape === 'array' ? 11 : 12);
      for (let round = 0; round < 400; round += 1) {
        const records = Array.from({ length: Math.floor(random() * 5) }, () => recordOf(random));
        const separator = pick(random, ['\n', '\r\n', ' ', '']);
        const text =
          shape === 'array'
            ? `[${records.map((record) => JSON.stringify(record)).join(`,${separator}`)}]`
            : records
                .map((record) => JSON.stringify(record))
                .join(separator === '' ? '\n' : separator);
        const label = `round ${round} ${JSON.stringify(text)}`;
        const whole = readAll([text]);
        const cut = readAll(chunks(random, text));
        expect(cut, label).toEqual(whole);
        expect(whole.length, label).toBe(records.length);
        for (const record of whole) {
          expect(record.ok, label).toBe(true);
        }
        for (const [index, record] of whole.entries()) {
          if (record.ok) {
            expect([...record.fields.keys()], label).toEqual(Object.keys(records[index] ?? {}));
          }
        }
      }
    });
  }
});

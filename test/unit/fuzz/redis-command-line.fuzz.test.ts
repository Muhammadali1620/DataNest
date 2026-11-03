import { describe, expect, it } from 'vitest';
import {
  type CommandWord,
  parseCommandLine,
  quoteCommandWord,
} from '../../../src/core/redis/command-line';
import { pick, pieces, seeded } from '../../helpers/fuzz';

const PARTS = [
  'a',
  'SET',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r',
  '"',
  "'",
  '\\',
  '\\x',
  '\\x41',
  '\\n',
  '\u0000',
  '\u007f',
  '\u001b',
  ' ',
  'é',
  '日本',
  '\u{1F600}',
  '#',
  '*',
];

function bytesOf(random: () => number): Uint8Array {
  const length = Math.floor(random() * 6);
  return Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

/** What a word reads back as: bytes that happen to be UTF-8 come back as text. */
function normal(word: CommandWord): string {
  if (typeof word === 'string') {
    return `s:${word}`;
  }
  try {
    return `s:${new TextDecoder('utf-8', { fatal: true }).decode(word)}`;
  } catch {
    return `b:${Array.from(word).join(',')}`;
  }
}

describe('Redis command lines written by quoteCommandWord and read by parseCommandLine', () => {
  it('give back every word, text or bytes', () => {
    const random = seeded(4242);
    for (let round = 0; round < 4000; round += 1) {
      const count = Math.floor(random() * 5);
      const words: CommandWord[] = Array.from({ length: count }, () =>
        random() < 0.2 ? bytesOf(random) : pieces(random, PARTS, 5),
      ).filter((word) => typeof word !== 'string' || !/[\uD800-\uDFFF]/u.test(word));
      const line = words.map(quoteCommandWord).join(pick(random, [' ', '  ', '\t']));
      const parsed = parseCommandLine(line);
      const label = `round ${round} ${JSON.stringify(line)}`;
      expect(parsed.ok, label).toBe(true);
      if (parsed.ok) {
        expect(parsed.words.map(normal), label).toEqual(words.map(normal));
      }
    }
  });

  it('never throws on any text, and reports a problem with an offset inside the line', () => {
    const random = seeded(99);
    for (let round = 0; round < 6000; round += 1) {
      const line = pieces(random, PARTS, 12);
      const parsed = parseCommandLine(line);
      if (!parsed.ok) {
        expect(parsed.offset, JSON.stringify(line)).toBeGreaterThanOrEqual(0);
        expect(parsed.offset, JSON.stringify(line)).toBeLessThan(line.length);
      }
    }
  });
});

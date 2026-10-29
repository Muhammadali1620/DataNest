import { describe, expect, it } from 'vitest';
import {
  type CommandWord,
  parseCommandLine,
  quoteCommandWord,
} from '../../../../src/core/redis/command-line';

function words(line: string): CommandWord[] {
  const parsed = parseCommandLine(line);
  if (!parsed.ok) {
    throw new Error(`did not parse: ${parsed.problem}`);
  }
  return parsed.words;
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('parseCommandLine', () => {
  it('splits words on any run of blanks', () => {
    expect(words('  SET   key\tvalue ')).toEqual(['SET', 'key', 'value']);
  });

  it('reads nothing from an empty or blank line', () => {
    expect(words('')).toEqual([]);
    expect(words('   \t ')).toEqual([]);
  });

  it('keeps spaces inside double and single quotes', () => {
    expect(words('SET "my key" \'a value\'')).toEqual(['SET', 'my key', 'a value']);
  });

  it('keeps an empty quoted word', () => {
    expect(words('SET k ""')).toEqual(['SET', 'k', '']);
    expect(words("SET k ''")).toEqual(['SET', 'k', '']);
  });

  it('reads escapes in double quotes', () => {
    expect(words('ECHO "a\\nb\\tc\\"d\\\\e\\rf\\bg\\ah\\q"')).toEqual([
      'ECHO',
      'a\nb\tc"d\\e\rf\bg\u0007hq',
    ]);
  });

  it('turns \\xHH escapes into raw bytes, joined with the text as UTF-8', () => {
    expect(words('SET "bin:\\xff\\xfe" x')).toEqual([
      'SET',
      bytes(0x62, 0x69, 0x6e, 0x3a, 0xff, 0xfe),
      'x',
    ]);
    expect(words('SET "\\x00й" x')[1]).toEqual(bytes(0x00, 0xd0, 0xb9));
  });

  it('leaves a \\x without two hex digits as text', () => {
    expect(words('ECHO "\\xg1"')).toEqual(['ECHO', 'xg1']);
  });

  it("knows only \\' inside single quotes", () => {
    expect(words("ECHO 'it\\'s \\n'")).toEqual(['ECHO', "it's \\n"]);
  });

  it('joins a bare prefix with the quoted part, as redis-cli does', () => {
    expect(words('ECHO pre"fix and"')).toEqual(['ECHO', 'prefix and']);
  });

  it('keeps Unicode text as it is', () => {
    expect(words('SET user:имя "Привет 👋"')).toEqual(['SET', 'user:имя', 'Привет 👋']);
  });

  it('refuses an unclosed quote and says where it opened', () => {
    expect(parseCommandLine('SET k "open')).toEqual({
      ok: false,
      problem: 'unclosed-quote',
      offset: 6,
    });
    expect(parseCommandLine("SET 'x")).toEqual({ ok: false, problem: 'unclosed-quote', offset: 4 });
  });

  it('refuses text glued to a closing quote', () => {
    expect(parseCommandLine('SET "a"b')).toEqual({
      ok: false,
      problem: 'quote-not-separated',
      offset: 7,
    });
  });
});

describe('quoteCommandWord', () => {
  it('leaves a plain word bare', () => {
    expect(quoteCommandWord('user:1')).toBe('user:1');
    expect(quoteCommandWord('имя')).toBe('имя');
  });

  it('quotes and escapes what would not read back bare', () => {
    expect(quoteCommandWord('')).toBe('""');
    expect(quoteCommandWord('a b')).toBe('"a b"');
    expect(quoteCommandWord('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
    expect(quoteCommandWord("it's")).toBe('"it\'s"');
    expect(quoteCommandWord('a\\b\tc\rd\u0001')).toBe('"a\\\\b\\tc\\rd\\x01"');
  });

  it('writes bytes that are not UTF-8 as hex escapes', () => {
    expect(quoteCommandWord(bytes(0x62, 0xff))).toBe('"\\x62\\xff"');
    expect(quoteCommandWord(bytes(0x6f, 0x6b))).toBe('ok');
  });

  it('round-trips through the parser', () => {
    for (const word of ['plain', '', 'two words', 'q"uo\'te', 'tab\tnew\nline', 'юни код', '\\']) {
      const [read] = words(`ECHO ${quoteCommandWord(word)}`).slice(1);
      expect(read).toEqual(word);
    }
    const binary = bytes(0, 1, 0xfe, 0xff, 0x20);
    expect(words(`ECHO ${quoteCommandWord(binary)}`)[1]).toEqual(binary);
  });
});

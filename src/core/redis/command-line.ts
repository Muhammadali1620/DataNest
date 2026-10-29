// One line of Redis commands as people type them in redis-cli: words split by blanks,
// "double quotes" with escapes (\n, \t, \xHH, \", \\) and 'single quotes' where only
// \' is special. A word made with \xHH escapes may hold any bytes, so it comes out
// as bytes; every other word stays text.

export type CommandWord = string | Uint8Array;

export type CommandLineProblem =
  /** A quote is not closed by the end of the line. */
  | 'unclosed-quote'
  /** A closing quote must be followed by a blank or the end of the line. */
  | 'quote-not-separated';

export type ParsedCommandLine =
  | { readonly ok: true; readonly words: CommandWord[] }
  | { readonly ok: false; readonly problem: CommandLineProblem; readonly offset: number };

const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  a: '\u0007',
};

const BLANK = /[ \t\n\r\f\v]/;

/** A word as it grows: text and raw bytes, joined as UTF-8 at the end. */
class WordBuilder {
  private readonly parts: Uint8Array[] = [];
  private text = '';
  private binary = false;

  addText(text: string): void {
    this.text += text;
  }

  addByte(byte: number): void {
    this.flush();
    this.parts.push(Uint8Array.of(byte));
    this.binary = true;
  }

  build(): CommandWord {
    if (!this.binary) {
      return this.text;
    }
    this.flush();
    const size = this.parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of this.parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  }

  private flush(): void {
    if (this.text !== '') {
      this.parts.push(new TextEncoder().encode(this.text));
      this.text = '';
    }
  }
}

function isHex(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char);
}

/** Splits a line into the words of one command; an empty line has none. */
export function parseCommandLine(line: string): ParsedCommandLine {
  const words: CommandWord[] = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && BLANK.test(line[index] ?? '')) {
      index++;
    }
    if (index >= line.length) {
      break;
    }
    const word = new WordBuilder();
    let quoted = false;
    while (index < line.length && !BLANK.test(line[index] ?? '')) {
      const char = line[index] ?? '';
      if (char === '"' || char === "'") {
        const start = index;
        index =
          char === '"' ? readDouble(line, index + 1, word) : readSingle(line, index + 1, word);
        if (index < 0) {
          return { ok: false, problem: 'unclosed-quote', offset: start };
        }
        if (index < line.length && !BLANK.test(line[index] ?? '')) {
          return { ok: false, problem: 'quote-not-separated', offset: index };
        }
        quoted = true;
        break;
      }
      word.addText(char);
      index++;
    }
    const built = word.build();
    if (quoted || built !== '') {
      words.push(built);
    }
  }
  return { ok: true, words };
}

/** Reads up to the closing `"`; the index after it, or -1 when there is none. */
function readDouble(line: string, from: number, word: WordBuilder): number {
  let index = from;
  while (index < line.length) {
    const char = line[index] ?? '';
    if (char === '"') {
      return index + 1;
    }
    if (char !== '\\' || index + 1 >= line.length) {
      word.addText(char);
      index++;
      continue;
    }
    const next = line[index + 1] ?? '';
    if (next === 'x' && isHex(line[index + 2]) && isHex(line[index + 3])) {
      word.addByte(Number.parseInt(line.slice(index + 2, index + 4), 16));
      index += 4;
      continue;
    }
    word.addText(DOUBLE_QUOTE_ESCAPES[next] ?? next);
    index += 2;
  }
  return -1;
}

/** Reads up to the closing `'`; only `\'` is an escape inside. */
function readSingle(line: string, from: number, word: WordBuilder): number {
  let index = from;
  while (index < line.length) {
    const char = line[index] ?? '';
    if (char === "'") {
      return index + 1;
    }
    if (char === '\\' && line[index + 1] === "'") {
      word.addText("'");
      index += 2;
      continue;
    }
    word.addText(char);
    index++;
  }
  return -1;
}

/**
 * Writes a word so `parseCommandLine` reads it back the same: bare when it is plain,
 * in double quotes with escapes otherwise. Bytes that are not UTF-8 become `\xHH`.
 */
export function quoteCommandWord(word: CommandWord): string {
  if (typeof word === 'string') {
    if (word !== '' && !/[\s"'\\\p{Cc}]/u.test(word)) {
      return word;
    }
    return `"${escapeText(word)}"`;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(word);
  } catch {
    // Not UTF-8: every byte is written as a hex escape.
    return `"${Array.from(word, (byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;
  }
  return quoteCommandWord(text);
}

function escapeText(text: string): string {
  let out = '';
  for (const char of text) {
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : char;
      }
    }
  }
  return out;
}

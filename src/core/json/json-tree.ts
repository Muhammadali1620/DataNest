import { msg } from '../user-message';
// JSON read into a tree that loses nothing (V7.8): numbers stay the text the server wrote
// (`9007199254740993` or `1.10` survive, which `JSON.parse` would round or trim), and
// object members keep their order and repeats. Written back laid out or on one line.

/** A JSON value; numbers are their text. */
export type JsonValue =
  | { readonly type: 'object'; readonly members: readonly JsonMember[] }
  | { readonly type: 'array'; readonly items: readonly JsonValue[] }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly text: string }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'null' };

export type JsonMember = readonly [name: string, value: JsonValue];

/** Text that is not JSON, and where. */
export class JsonSyntaxError extends Error {
  override readonly name = 'JsonSyntaxError';

  constructor(
    message: string,
    /** 0-based offset in the text. */
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Deeper than this is a mistake (or an attack), not a document. */
const MAX_DEPTH = 500;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Reader {
  offset = 0;

  constructor(private readonly text: string) {}

  fail(message: string, at = this.offset): never {
    throw new JsonSyntaxError(message, at);
  }

  space(): void {
    while (this.offset < this.text.length && ' \t\r\n'.includes(this.text[this.offset] ?? '')) {
      this.offset += 1;
    }
  }

  value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) {
      this.fail(msg('The JSON nests too deeply'));
    }
    this.space();
    const char = this.text[this.offset] ?? '';
    switch (char) {
      case '{':
        return this.object(depth);
      case '[':
        return this.array(depth);
      case '"':
        return { type: 'string', value: this.string() };
      case 't':
        return this.word('true', { type: 'bool', value: true });
      case 'f':
        return this.word('false', { type: 'bool', value: false });
      case 'n':
        return this.word('null', { type: 'null' });
      case '':
        return this.fail(msg('Expected a value at the end'));
      default: {
        NUMBER.lastIndex = this.offset;
        const match = NUMBER.exec(this.text);
        if (match === null || match[0] === '-') {
          return this.fail(msg('Unexpected "{0}"', char));
        }
        this.offset += match[0].length;
        return { type: 'number', text: match[0] };
      }
    }
  }

  private word(word: string, value: JsonValue): JsonValue {
    if (!this.text.startsWith(word, this.offset)) {
      this.fail(msg('Unexpected "{0}"', this.text[this.offset] ?? ''));
    }
    this.offset += word.length;
    return value;
  }

  private object(depth: number): JsonValue {
    this.offset += 1;
    const members: JsonMember[] = [];
    this.space();
    if (this.text[this.offset] === '}') {
      this.offset += 1;
      return { type: 'object', members };
    }
    for (;;) {
      this.space();
      if (this.text[this.offset] !== '"') {
        this.fail(msg('Expected a name in double quotes'));
      }
      const name = this.string();
      this.space();
      if (this.text[this.offset] !== ':') {
        this.fail(msg('Expected ":" after the name'));
      }
      this.offset += 1;
      members.push([name, this.value(depth + 1)]);
      this.space();
      const next = this.text[this.offset];
      this.offset += 1;
      if (next === '}') {
        return { type: 'object', members };
      }
      if (next !== ',') {
        this.fail(msg('Expected "," or "}"'), this.offset - 1);
      }
    }
  }

  private array(depth: number): JsonValue {
    this.offset += 1;
    const items: JsonValue[] = [];
    this.space();
    if (this.text[this.offset] === ']') {
      this.offset += 1;
      return { type: 'array', items };
    }
    for (;;) {
      items.push(this.value(depth + 1));
      this.space();
      const next = this.text[this.offset];
      this.offset += 1;
      if (next === ']') {
        return { type: 'array', items };
      }
      if (next !== ',') {
        this.fail(msg('Expected "," or "]"'), this.offset - 1);
      }
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    let out = '';
    for (;;) {
      const char = this.text[this.offset];
      if (char === undefined) {
        this.fail(msg('The string is not closed'), start);
      }
      if (char === '"') {
        this.offset += 1;
        return out;
      }
      if (char < ' ') {
        this.fail(msg('A control character inside a string'));
      }
      if (char === '\\') {
        const escape = this.text[this.offset + 1] ?? '';
        const simple: Readonly<Record<string, string>> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        if (escape === 'u') {
          const hex = this.text.slice(this.offset + 2, this.offset + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail(msg('A wrong \\u escape'));
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.offset += 6;
          continue;
        }
        const replaced = simple[escape];
        if (replaced === undefined) {
          this.fail(msg('A wrong escape'));
        }
        out += replaced;
        this.offset += 2;
        continue;
      }
      out += char;
      this.offset += 1;
    }
  }

  end(): void {
    this.space();
    if (this.offset < this.text.length) {
      this.fail(msg('Unexpected text after the JSON'));
    }
  }
}

export function parseJson(text: string): JsonValue {
  const reader = new Reader(text);
  const value = reader.value(0);
  reader.end();
  return value;
}

/** Every JSON value of NDJSON text, one per line, with the offset each starts at. */
export function parseJsonLines(text: string): { value: JsonValue; offset: number }[] {
  const values: { value: JsonValue; offset: number }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.trim() !== '') {
      try {
        values.push({ value: parseJson(line), offset });
      } catch (error) {
        if (error instanceof JsonSyntaxError) {
          throw new JsonSyntaxError(error.message, offset + error.offset);
        }
        throw error;
      }
    }
    offset += line.length + 1;
  }
  return values;
}

/** One line, as servers write it and as NDJSON needs it. */
export function formatJsonLine(value: JsonValue): string {
  switch (value.type) {
    case 'object':
      return `{${value.members.map(([name, item]) => `${JSON.stringify(name)}:${formatJsonLine(item)}`).join(',')}}`;
    case 'array':
      return `[${value.items.map(formatJsonLine).join(',')}]`;
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
      return value.text;
    case 'bool':
      return String(value.value);
    case 'null':
      return 'null';
  }
}

/** Laid out with two spaces a level, for reading. */
export function formatJson(value: JsonValue, depth = 0): string {
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  switch (value.type) {
    case 'object':
      return value.members.length === 0
        ? '{}'
        : `{\n${value.members.map(([name, item]) => `${pad}${JSON.stringify(name)}: ${formatJson(item, depth + 1)}`).join(',\n')}\n${close}}`;
    case 'array': {
      if (value.items.length === 0) {
        return '[]';
      }
      const plain = value.items.every((item) => item.type !== 'object' && item.type !== 'array');
      const line = `[${value.items.map(formatJsonLine).join(', ')}]`;
      return plain && line.length <= 80
        ? line
        : `[\n${value.items.map((item) => `${pad}${formatJson(item, depth + 1)}`).join(',\n')}\n${close}]`;
    }
    case 'string':
    case 'number':
    case 'bool':
    case 'null':
      return formatJsonLine(value);
  }
}

/** The first member called `name`, or undefined. */
export function member(value: JsonValue | undefined, name: string): JsonValue | undefined {
  return value?.type === 'object' ? value.members.find(([key]) => key === name)?.[1] : undefined;
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  return value?.type === 'string' ? value.value : undefined;
}

/** A number or a numeric string (`_cat` APIs give counts as text) as decimal text. */
export function jsonNumberText(value: JsonValue | undefined): string | undefined {
  if (value?.type === 'number') {
    return value.text;
  }
  return value?.type === 'string' && /^-?\d+(\.\d+)?$/.test(value.value) ? value.value : undefined;
}

/** A short one-line preview for a table cell, cut at `max` characters. */
export function previewJson(value: JsonValue, max: number): string {
  const text =
    value.type === 'string' ? value.value.replace(/[\r\n]+/g, ' ') : formatJsonLine(value);
  if (text.length <= max) {
    return text;
  }
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

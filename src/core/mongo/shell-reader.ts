// Reads values written in the MongoDB shell's syntax (V7.5): JSON with bare names,
// single quotes, comments and trailing commas, plus the shell's constructors —
// `ObjectId("…")`, `ISODate("…")`, `NumberLong("…")`, `/regex/i`. Nothing is evaluated:
// it is a parser of data, so pasting text from anywhere cannot run code (§8).
// Statement parsers (the query editor, V7.7) use the same reader for their arguments.

import { newObjectId } from './object-id';
import { hexToBase64 } from './shell-format';
import type { MongoDocument, MongoField, MongoValue } from './value';
import { msg } from '../user-message';

/** Something that is not valid shell data, and where. */
export class ShellSyntaxError extends Error {
  override readonly name = 'ShellSyntaxError';

  constructor(
    message: string,
    /** 0-based offset in the text. */
    readonly offset: number,
  ) {
    super(message);
  }
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Deeper than this is a mistake (or an attack), not a document. */
const MAX_DEPTH = 200;

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

export class ShellReader {
  /** The offset of the next character to read. */
  offset = 0;

  constructor(readonly text: string) {}

  fail(message: string, offset = this.offset): never {
    throw new ShellSyntaxError(message, offset);
  }

  atEnd(): boolean {
    this.skipSpace();
    return this.offset >= this.text.length;
  }

  peek(): string {
    return this.text[this.offset] ?? '';
  }

  /** Skips spaces, line breaks and comments. */
  skipSpace(): void {
    for (;;) {
      const char = this.peek();
      if (char === '') {
        return;
      }
      if (/\s/.test(char) || char === '\uFEFF') {
        this.offset += 1;
        continue;
      }
      if (char === '/' && this.text[this.offset + 1] === '/') {
        const end = this.text.indexOf('\n', this.offset);
        this.offset = end < 0 ? this.text.length : end + 1;
        continue;
      }
      if (char === '/' && this.text[this.offset + 1] === '*') {
        const end = this.text.indexOf('*/', this.offset + 2);
        if (end < 0) {
          this.fail(msg('The comment is not closed'));
        }
        this.offset = end + 2;
        continue;
      }
      return;
    }
  }

  /** Takes `char` when it comes next; true if it did. */
  accept(char: string): boolean {
    this.skipSpace();
    if (this.text.startsWith(char, this.offset)) {
      this.offset += char.length;
      return true;
    }
    return false;
  }

  expect(char: string, what = `"${char}"`): void {
    if (!this.accept(char)) {
      this.fail(msg('Expected {0}{1}', what, this.near()));
    }
  }

  /** " at the end" / " near `…`", for messages. */
  near(): string {
    this.skipSpace();
    if (this.offset >= this.text.length) {
      return msg(' at the end');
    }
    const rest = this.text.slice(this.offset, this.offset + 12).split('\n')[0] ?? '';
    return msg(' near `{0}`', rest);
  }

  /** A name made of identifier characters, or undefined when none comes next. */
  identifier(): string | undefined {
    this.skipSpace();
    if (!IDENTIFIER_START.test(this.peek())) {
      return undefined;
    }
    const start = this.offset;
    while (IDENTIFIER_PART.test(this.peek())) {
      this.offset += 1;
    }
    return this.text.slice(start, this.offset);
  }

  /** One value: a document, an array, a string, a number, a constructor, … */
  value(depth = 0): MongoValue {
    if (depth > MAX_DEPTH) {
      this.fail(msg('The value nests too deeply'));
    }
    this.skipSpace();
    const start = this.offset;
    const char = this.peek();
    if (char === '{') {
      return this.document(depth);
    }
    if (char === '[') {
      return this.array(depth);
    }
    if (char === '"' || char === "'" || char === '`') {
      return { type: 'string', value: this.string() };
    }
    if (char === '/') {
      return this.regexLiteral();
    }
    if (char === '-' || char === '+' || char === '.' || /\d/.test(char)) {
      return this.number();
    }
    const word = this.identifier();
    if (word === undefined) {
      this.fail(
        char === '' ? msg('Expected a value at the end') : msg('Unexpected "{0}"', char),
        start,
      );
    }
    return this.word(word, start, depth);
  }

  document(depth: number): MongoDocument {
    this.expect('{');
    const fields: MongoField[] = [];
    while (!this.accept('}')) {
      this.skipSpace();
      const name = this.name();
      this.expect(':', msg('":" after the field name'));
      fields.push([name, this.value(depth + 1)]);
      if (!this.accept(',')) {
        this.expect('}', msg('"," or "}"'));
        break;
      }
    }
    return { type: 'document', fields };
  }

  private array(depth: number): MongoValue {
    this.expect('[');
    const items: MongoValue[] = [];
    while (!this.accept(']')) {
      items.push(this.value(depth + 1));
      if (!this.accept(',')) {
        this.expect(']', msg('"," or "]"'));
        break;
      }
    }
    return { type: 'array', items };
  }

  /** A field name: bare, quoted, or a number (`{ 12: "x" }` names the field "12"). */
  private name(): string {
    const char = this.peek();
    if (char === '"' || char === "'" || char === '`') {
      return this.string();
    }
    if (/\d/.test(char)) {
      const start = this.offset;
      while (/[\d.]/.test(this.peek())) {
        this.offset += 1;
      }
      return this.text.slice(start, this.offset);
    }
    const word = this.identifier();
    if (word === undefined) {
      this.fail(msg('Expected a field name{0}', this.near()));
    }
    return word;
  }

  /** A quoted string with JavaScript's escapes; a template literal may not interpolate. */
  string(): string {
    this.skipSpace();
    const quote = this.peek();
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      this.fail(msg('Expected a string{0}', this.near()));
    }
    const start = this.offset;
    this.offset += 1;
    let out = '';
    for (;;) {
      const char = this.peek();
      if (char === '') {
        this.fail(msg('The string is not closed'), start);
      }
      if (char === quote) {
        this.offset += 1;
        return out;
      }
      if ((char === '\n' || char === '\r') && quote !== '`') {
        this.fail(msg('A line break inside a string; write it as \\n'), this.offset);
      }
      if (quote === '`' && char === '$' && this.text[this.offset + 1] === '{') {
        this.fail(msg('Templates with ${…} are not data: write the value itself'));
      }
      if (char === '\\') {
        out += this.escape();
        continue;
      }
      out += char;
      this.offset += 1;
    }
  }

  private escape(): string {
    const at = this.offset;
    const char = this.text[this.offset + 1] ?? '';
    this.offset += 2;
    switch (char) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        if (/\d/.test(this.peek())) {
          this.fail(msg('Octal escapes are not allowed'), at);
        }
        return '\0';
      case 'x':
        return String.fromCharCode(this.hexDigits(2, at));
      case 'u': {
        if (this.peek() === '{') {
          const end = this.text.indexOf('}', this.offset);
          const hex = end < 0 ? '' : this.text.slice(this.offset + 1, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) {
            this.fail(msg('A wrong \\u{…} escape'), at);
          }
          this.offset = end + 1;
          return String.fromCodePoint(Number.parseInt(hex, 16));
        }
        return String.fromCharCode(this.hexDigits(4, at));
      }
      case '\r':
        // A line continuation: the break itself is not part of the string.
        if (this.peek() === '\n') {
          this.offset += 1;
        }
        return '';
      case '\n':
      case '\u2028':
      case '\u2029':
        return '';
      case '':
        return this.fail(msg('The string is not closed'), at);
      default:
        return char;
    }
  }

  private hexDigits(count: number, at: number): number {
    const hex = this.text.slice(this.offset, this.offset + count);
    if (hex.length !== count || !/^[0-9a-fA-F]+$/.test(hex)) {
      this.fail(msg('A wrong escape'), at);
    }
    this.offset += count;
    return Number.parseInt(hex, 16);
  }

  /**
   * A number. An integer is an int32 when it fits and an int64 when not — never a double
   * that would round it (D24); a point or an exponent makes a double.
   */
  private number(): MongoValue {
    const start = this.offset;
    let sign = '';
    if (this.peek() === '-' || this.peek() === '+') {
      sign = this.peek();
      this.offset += 1;
      this.skipSpace();
      const word = /^(Infinity|NaN)\b/.exec(this.text.slice(this.offset));
      if (word !== null) {
        this.offset += word[1]?.length ?? 0;
        const text = word[1] === 'NaN' ? 'NaN' : sign === '-' ? '-Infinity' : 'Infinity';
        return { type: 'double', value: text };
      }
    }
    const rest = this.text.slice(this.offset);
    const hex = /^0[xX][0-9a-fA-F]+/.exec(rest);
    if (hex !== null) {
      this.offset += hex[0].length;
      return this.integer(BigInt(hex[0]) * (sign === '-' ? -1n : 1n), start);
    }
    const match = /^(\d+)?(\.\d*)?([eE][+-]?\d+)?/.exec(rest);
    const [whole = '', digits, fraction, exponent] = match ?? [];
    if (whole === '' || whole === '.' || (digits === undefined && fraction === undefined)) {
      this.fail(msg('Expected a number'), start);
    }
    this.offset += whole.length;
    if (IDENTIFIER_PART.test(this.peek())) {
      this.fail(msg('Unexpected "{0}" in a number', this.peek()));
    }
    if (fraction === undefined && exponent === undefined) {
      return this.integer(BigInt(digits ?? '0') * (sign === '-' ? -1n : 1n), start);
    }
    const number = Number(`${sign}${whole}`);
    return { type: 'double', value: Object.is(number, -0) ? '-0' : String(number) };
  }

  private integer(value: bigint, start: number): MongoValue {
    if (value >= BigInt(INT32_MIN) && value <= BigInt(INT32_MAX)) {
      return { type: 'int32', value: Number(value) };
    }
    if (value >= INT64_MIN && value <= INT64_MAX) {
      return { type: 'int64', value: value.toString() };
    }
    return this.fail(
      msg(
        'The number is too large for a 64-bit integer: write it with a point for a double, or as NumberDecimal("…")',
      ),
      start,
    );
  }

  private regexLiteral(): MongoValue {
    const start = this.offset;
    this.offset += 1;
    let pattern = '';
    let inClass = false;
    for (;;) {
      const char = this.peek();
      if (char === '' || char === '\n' || char === '\r') {
        this.fail(msg('The regular expression is not closed'), start);
      }
      this.offset += 1;
      if (char === '\\') {
        const next = this.peek();
        // `\/` only keeps the slash out of the literal's end; the pattern stays as written.
        pattern += char + next;
        this.offset += 1;
        continue;
      }
      if (char === '[') {
        inClass = true;
      } else if (char === ']') {
        inClass = false;
      } else if (char === '/' && !inClass) {
        break;
      }
      pattern += char;
    }
    const flagStart = this.offset;
    while (/[a-z]/i.test(this.peek())) {
      this.offset += 1;
    }
    return { type: 'regex', pattern, flags: sortedFlags(this.text.slice(flagStart, this.offset)) };
  }

  /** A name standing for a value: `true`, `null`, `MinKey`, or a constructor call. */
  private word(word: string, start: number, depth: number): MongoValue {
    switch (word) {
      case 'true':
        return { type: 'bool', value: true };
      case 'false':
        return { type: 'bool', value: false };
      case 'null':
        return { type: 'null' };
      case 'undefined':
        return { type: 'undefined' };
      case 'NaN':
        return { type: 'double', value: 'NaN' };
      case 'Infinity':
        return { type: 'double', value: 'Infinity' };
      case 'new': {
        const name = this.identifier();
        if (name === undefined) {
          this.fail(msg('Expected a constructor after "new"{0}', this.near()));
        }
        return this.call(name, start, depth);
      }
      default:
        return this.call(word, start, depth);
    }
  }

  /** The arguments of a constructor call; `MinKey` and `MaxKey` may leave them out. */
  private args(depth: number): MongoValue[] {
    const values: MongoValue[] = [];
    this.expect('(');
    while (!this.accept(')')) {
      values.push(this.value(depth + 1));
      if (!this.accept(',')) {
        this.expect(')', msg('"," or ")"'));
        break;
      }
    }
    return values;
  }

  private call(name: string, start: number, depth: number): MongoValue {
    if ((name === 'MinKey' || name === 'MaxKey') && !this.text.startsWith('(', this.skipped())) {
      return { type: name === 'MinKey' ? 'minKey' : 'maxKey' };
    }
    if (!this.text.startsWith('(', this.skipped())) {
      this.fail(msg('Unknown value "{0}"', name), start);
    }
    const args = this.args(depth);
    const constructor = CONSTRUCTORS.get(name);
    if (constructor === undefined) {
      this.fail(msg('Unknown constructor {0}(); DataNest reads data, not code', name), start);
    }
    const result = constructor(args, (message) => this.fail(`${name}(): ${message}`, start));
    return result;
  }

  /** The offset after spaces, without moving. */
  private skipped(): number {
    const keep = this.offset;
    this.skipSpace();
    const at = this.offset;
    this.offset = keep;
    return at;
  }
}

/** BSON keeps regex flags sorted. */
function sortedFlags(flags: string): string {
  return [...new Set(flags)].sort().join('');
}

type Fail = (message: string) => never;
type Constructor = (args: readonly MongoValue[], fail: Fail) => MongoValue;

function textArg(args: readonly MongoValue[], index: number, fail: Fail, what: string): string {
  const arg = args[index];
  if (arg?.type !== 'string') {
    fail(msg('expects {0} as a string', what));
  }
  return arg.value;
}

function numberArg(args: readonly MongoValue[], index: number, fail: Fail, what: string): number {
  const arg = args[index];
  if (arg?.type === 'int32') {
    return arg.value;
  }
  if (arg?.type === 'int64' || arg?.type === 'double') {
    return Number(arg.value);
  }
  return fail(msg('expects {0} as a number', what));
}

function arity(args: readonly MongoValue[], min: number, max: number, fail: Fail): void {
  if (args.length < min || args.length > max) {
    fail(
      min === max ? msg('takes {0} argument(s)', min) : msg('takes {0} to {1} arguments', min, max),
    );
  }
}

function int64Text(value: MongoValue, fail: Fail): string {
  let big: bigint;
  if (value.type === 'string') {
    if (!/^[+-]?\d+$/.test(value.value.trim())) {
      fail(msg('expects a whole number'));
    }
    big = BigInt(value.value.trim());
  } else if (value.type === 'int32' || value.type === 'int64') {
    big = BigInt(value.value);
  } else if (value.type === 'double' && Number.isSafeInteger(Number(value.value))) {
    big = BigInt(Number(value.value));
  } else {
    return fail(msg('expects a whole number'));
  }
  if (big < INT64_MIN || big > INT64_MAX) {
    fail(msg('is out of the 64-bit range'));
  }
  return big.toString();
}

/** Decimal128 text: digits, an optional point and exponent, or the special values. */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^[+-]?(Infinity|Inf|NaN)$/i;

function dateFrom(args: readonly MongoValue[], fail: Fail): MongoValue {
  arity(args, 0, 1, fail);
  const [arg] = args;
  if (arg === undefined) {
    return { type: 'date', value: String(Date.now()) };
  }
  if (arg.type === 'string') {
    const text = arg.value.trim();
    // A date alone is midnight UTC, as the shell takes it.
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? Date.parse(`${text}T00:00:00Z`)
      : Date.parse(text);
    if (Number.isNaN(ms) || !/^[+-]?\d{4,6}-\d{2}-\d{2}/.test(text)) {
      fail(msg('expects an ISO date, e.g. "2026-10-29T12:00:00Z"'));
    }
    return { type: 'date', value: String(ms) };
  }
  if (arg.type === 'int32' || arg.type === 'int64' || arg.type === 'double') {
    const text = int64Text(arg, fail);
    return { type: 'date', value: text };
  }
  return fail(msg('expects an ISO date or milliseconds since 1970'));
}

const CONSTRUCTORS: ReadonlyMap<string, Constructor> = new Map<string, Constructor>([
  [
    'ObjectId',
    (args, fail) => {
      arity(args, 0, 1, fail);
      if (args.length === 0) {
        return { type: 'objectId', value: newObjectId() };
      }
      const hex = textArg(args, 0, fail, msg('the 24 hex digits')).trim();
      if (!/^[0-9a-fA-F]{24}$/.test(hex)) {
        fail(msg('expects 24 hex digits'));
      }
      return { type: 'objectId', value: hex.toLowerCase() };
    },
  ],
  ['ISODate', dateFrom],
  ['Date', dateFrom],
  [
    'NumberLong',
    (args, fail) => {
      arity(args, 1, 1, fail);
      return { type: 'int64', value: int64Text(args[0] ?? { type: 'null' }, fail) };
    },
  ],
  [
    'NumberInt',
    (args, fail) => {
      arity(args, 1, 1, fail);
      const arg = args[0];
      const number =
        arg?.type === 'string' ? Number(arg.value) : numberArg(args, 0, fail, msg('the value'));
      if (!Number.isInteger(number) || number < INT32_MIN || number > INT32_MAX) {
        fail(msg('expects a whole number within 32 bits'));
      }
      return { type: 'int32', value: number };
    },
  ],
  [
    'Double',
    (args, fail) => {
      arity(args, 1, 1, fail);
      const arg = args[0];
      const number =
        arg?.type === 'string' ? Number(arg.value) : numberArg(args, 0, fail, msg('the value'));
      return { type: 'double', value: Object.is(number, -0) ? '-0' : String(number) };
    },
  ],
  [
    'NumberDecimal',
    (args, fail) => {
      arity(args, 1, 1, fail);
      const arg = args[0];
      const text =
        arg?.type === 'string'
          ? arg.value.trim()
          : arg?.type === 'int32' || arg?.type === 'int64' || arg?.type === 'double'
            ? String(arg.value)
            : '';
      if (!DECIMAL.test(text)) {
        fail(msg('expects a decimal number as a string, e.g. "12.50"'));
      }
      return { type: 'decimal', value: text };
    },
  ],
  [
    'BinData',
    (args, fail) => {
      arity(args, 2, 2, fail);
      const subtype = numberArg(args, 0, fail, msg('the subtype'));
      const base64 = textArg(args, 1, fail, msg('the base64 data')).replace(/\s+/g, '');
      if (!Number.isInteger(subtype) || subtype < 0 || subtype > 255) {
        fail(msg('expects a subtype from 0 to 255'));
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
        fail(msg('expects base64 data'));
      }
      return { type: 'binary', subtype, value: base64 };
    },
  ],
  [
    'HexData',
    (args, fail) => {
      arity(args, 2, 2, fail);
      const subtype = numberArg(args, 0, fail, msg('the subtype'));
      const hex = textArg(args, 1, fail, msg('the hex data')).replace(/\s+/g, '');
      if (
        !/^([0-9a-fA-F]{2})*$/.test(hex) ||
        !Number.isInteger(subtype) ||
        subtype < 0 ||
        subtype > 255
      ) {
        fail(msg('expects a subtype and hex digits'));
      }
      return { type: 'binary', subtype, value: hexToBase64(hex.toLowerCase()) };
    },
  ],
  [
    'UUID',
    (args, fail) => {
      arity(args, 1, 1, fail);
      const hex = textArg(args, 0, fail, msg('the UUID')).replaceAll('-', '');
      if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
        fail(msg('expects 32 hex digits, dashes allowed'));
      }
      return { type: 'binary', subtype: 4, value: hexToBase64(hex.toLowerCase()) };
    },
  ],
  [
    'Timestamp',
    (args, fail) => {
      let t: number;
      let i: number;
      const [first] = args;
      if (args.length === 1 && first?.type === 'document') {
        const get = (name: string): number => {
          const found = first.fields.find(([key]) => key === name)?.[1];
          return found === undefined ? Number.NaN : numberArg([found], 0, fail, name);
        };
        t = get('t');
        i = get('i');
      } else {
        arity(args, 2, 2, fail);
        t = numberArg(args, 0, fail, msg('the seconds'));
        i = numberArg(args, 1, fail, msg('the increment'));
      }
      const valid = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff;
      if (!valid(t) || !valid(i)) {
        fail(msg('expects whole numbers t and i within 32 bits'));
      }
      return { type: 'timestamp', t, i };
    },
  ],
  [
    'MinKey',
    (args, fail) => {
      arity(args, 0, 0, fail);
      return { type: 'minKey' };
    },
  ],
  [
    'MaxKey',
    (args, fail) => {
      arity(args, 0, 0, fail);
      return { type: 'maxKey' };
    },
  ],
  [
    'RegExp',
    (args, fail) => {
      arity(args, 1, 2, fail);
      const pattern = textArg(args, 0, fail, msg('the pattern'));
      const flags = args.length > 1 ? textArg(args, 1, fail, msg('the flags')) : '';
      if (!/^[a-z]*$/i.test(flags)) {
        fail(msg('expects letters as flags'));
      }
      return { type: 'regex', pattern, flags: sortedFlags(flags) };
    },
  ],
  [
    'Code',
    (args, fail) => {
      arity(args, 1, 2, fail);
      const code = textArg(args, 0, fail, msg('the code'));
      const scope = args[1];
      if (scope === undefined) {
        return { type: 'code', value: code };
      }
      if (scope.type !== 'document') {
        return fail(msg('expects a document as the scope'));
      }
      return { type: 'code', value: code, scope };
    },
  ],
  [
    'DBRef',
    (args, fail) => {
      arity(args, 2, 3, fail);
      const collection = textArg(args, 0, fail, msg('the collection'));
      const fields: MongoField[] = [
        ['$ref', { type: 'string', value: collection }],
        ['$id', args[1] ?? { type: 'null' }],
      ];
      if (args.length > 2) {
        fields.push([
          '$db',
          { type: 'string', value: textArg(args, 2, fail, msg('the database')) },
        ]);
      }
      return { type: 'document', fields };
    },
  ],
]);

for (const [alias, name] of [
  ['Long', 'NumberLong'],
  ['Int32', 'NumberInt'],
  ['Decimal128', 'NumberDecimal'],
  ['BSONRegExp', 'RegExp'],
] as const) {
  const constructor = CONSTRUCTORS.get(name);
  if (constructor !== undefined) {
    (CONSTRUCTORS as Map<string, Constructor>).set(alias, constructor);
  }
}

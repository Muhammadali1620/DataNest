// Writes a MongoValue the way the MongoDB shell reads it (V7.5): `{ _id: ObjectId("…"),
// total: NumberDecimal("1.50"), at: ISODate("…") }`. What it writes, shell-parse.ts reads
// back to the same BSON: an int32 is `1`, a double always shows a point or an exponent
// (`2.0`), so editing a document never changes the type of a field nobody touched.

import type { MongoDocument, MongoValue } from './value';

/** Names written bare: what a JavaScript identifier may be, `$` included. */
const BARE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function formatName(name: string): string {
  return BARE_NAME.test(name) ? name : JSON.stringify(name);
}

/** A double as the shell writes it: `1.5`, `2.0`, `1e+21`, `NaN`, `-0.0`. */
export function formatDouble(text: string): string {
  switch (text) {
    case 'NaN':
    case 'Infinity':
    case '-Infinity':
      return text;
    case '-0':
      return '-0.0';
    default:
      return /[.eE]/.test(text) ? text : `${text}.0`;
  }
}

/** ISO text of a date in years 0–9999; undefined outside them (`new Date(ms)` instead). */
export function isoDate(ms: string): string | undefined {
  const number = Number(ms);
  if (!Number.isSafeInteger(number) || Math.abs(number) > 8.64e15) {
    return undefined;
  }
  const date = new Date(number);
  const year = date.getUTCFullYear();
  return year < 0 || year > 9999 ? undefined : date.toISOString();
}

/** A UUID's text from the 16 bytes of a subtype 4 binary; undefined when it is not one. */
export function uuidText(binary: {
  readonly subtype: number;
  readonly value: string;
}): string | undefined {
  if (binary.subtype !== 4) {
    return undefined;
  }
  const hex = base64ToHex(binary.value);
  if (hex?.length !== 32) {
    return undefined;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 to hex without Buffer: core runs in the webview too. */
export function base64ToHex(base64: string): string | undefined {
  const clean = base64.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) {
    return undefined;
  }
  let bits = 0;
  let count = 0;
  let hex = '';
  for (const char of clean) {
    bits = (bits << 6) | BASE64.indexOf(char);
    count += 6;
    if (count >= 8) {
      count -= 8;
      hex += ((bits >> count) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

export function hexToBase64(hex: string): string {
  let out = '';
  for (let at = 0; at < hex.length; at += 6) {
    const chunk = hex.slice(at, at + 6);
    const bytes = chunk.length / 2;
    const bits = Number.parseInt(chunk.padEnd(6, '0'), 16);
    for (let index = 0; index < 4; index += 1) {
      out += index <= bytes ? (BASE64[(bits >> (18 - index * 6)) & 0x3f] ?? '') : '=';
    }
  }
  return out;
}

/** `/pattern/flags`, or `RegExp("…", "…")` when a literal could not hold the pattern. */
function formatRegex(pattern: string, flags: string): string {
  if (pattern === '' || /[\n\r\u2028\u2029]/.test(pattern)) {
    return `RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)})`;
  }
  // A `/` the pattern has not escaped would end the literal early.
  let escaped = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    if (char === '\\') {
      escaped += char + (pattern[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      escaped += '\\/';
      continue;
    }
    escaped += char;
  }
  return `/${escaped}/${flags}`;
}

/** One value on one line: what a tree label, a cell or a short message shows. */
export function formatValue(value: MongoValue): string {
  return write(value, undefined, 0);
}

/** A value laid out over lines with two spaces per level, for reading and editing. */
export function formatPretty(value: MongoValue): string {
  return write(value, '  ', 0);
}

/** Arrays of plain values this short stay on one line even when laid out. */
const INLINE_ARRAY = 60;

function isScalar(value: MongoValue): boolean {
  return value.type !== 'document' && value.type !== 'array';
}

function write(value: MongoValue, indent: string | undefined, depth: number): string {
  switch (value.type) {
    case 'document':
      return writeDocument(value, indent, depth);
    case 'array': {
      if (value.items.length === 0) {
        return '[]';
      }
      const inline = value.items.map((item) => write(item, undefined, depth + 1));
      const short = `[${inline.join(', ')}]`;
      if (indent === undefined || (value.items.every(isScalar) && short.length <= INLINE_ARRAY)) {
        return short;
      }
      const inner = indent.repeat(depth + 1);
      return `[\n${value.items
        .map((item) => `${inner}${write(item, indent, depth + 1)}`)
        .join(',\n')}\n${indent.repeat(depth)}]`;
    }
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'bool':
      return String(value.value);
    case 'int32':
      return String(value.value);
    case 'int64':
      return `NumberLong("${value.value}")`;
    case 'double':
      return formatDouble(value.value);
    case 'decimal':
      return `NumberDecimal("${value.value}")`;
    case 'string':
      return JSON.stringify(value.value);
    case 'objectId':
      return `ObjectId("${value.value}")`;
    case 'date': {
      const iso = isoDate(value.value);
      return iso === undefined ? `new Date(${value.value})` : `ISODate("${iso}")`;
    }
    case 'binary': {
      const uuid = uuidText(value);
      return uuid === undefined ? `BinData(${value.subtype}, "${value.value}")` : `UUID("${uuid}")`;
    }
    case 'regex':
      return formatRegex(value.pattern, value.flags);
    case 'timestamp':
      return `Timestamp(${value.t}, ${value.i})`;
    case 'minKey':
      return 'MinKey()';
    case 'maxKey':
      return 'MaxKey()';
    case 'code':
      return value.scope === undefined
        ? `Code(${JSON.stringify(value.value)})`
        : `Code(${JSON.stringify(value.value)}, ${write(value.scope, indent, depth)})`;
    case 'symbol':
      return `Symbol(${JSON.stringify(value.value)})`;
    case 'dbPointer':
      return `DBPointer(${JSON.stringify(value.ns)}, ObjectId("${value.id}"))`;
  }
}

function writeDocument(value: MongoDocument, indent: string | undefined, depth: number): string {
  if (value.fields.length === 0) {
    return '{}';
  }
  if (indent === undefined) {
    return `{ ${value.fields.map(([name, item]) => `${formatName(name)}: ${write(item, undefined, depth + 1)}`).join(', ')} }`;
  }
  const inner = indent.repeat(depth + 1);
  return `{\n${value.fields
    .map(([name, item]) => `${inner}${formatName(name)}: ${write(item, indent, depth + 1)}`)
    .join(',\n')}\n${indent.repeat(depth)}}`;
}

/**
 * A one-line preview cut to `max` characters, for a table cell: long strings and big
 * documents end in `…`. Not meant to be parsed back.
 */
export function previewValue(value: MongoValue, max: number): string {
  if (value.type === 'string') {
    return cut(value.value.replace(/[\r\n]+/g, ' '), max);
  }
  return cut(formatValue(value), max);
}

function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  // Never split a surrogate pair: half an emoji shows as a broken glyph.
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

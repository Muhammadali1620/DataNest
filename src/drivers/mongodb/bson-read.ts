// Reads raw BSON (what a cursor returns with `raw: true`) into a MongoDocument, field
// by field in the order of the bytes (D88). The `bson` library would build a JavaScript
// object, which moves names like "12" to the front.

import { Decimal128 } from 'mongodb';
import { DbError } from '../../core/errors';
import type { MongoDocument, MongoField, MongoValue } from '../../core/mongo/value';

const UTF8 = new TextDecoder('utf-8');

/** Documents nest no deeper than this; the server allows 100 levels. */
const MAX_DEPTH = 200;

class Reader {
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  document(offset: number, depth: number): { document: MongoDocument; end: number } {
    if (depth > MAX_DEPTH) {
      throw broken('it nests too deeply');
    }
    const size = this.int32(offset);
    const end = offset + size;
    if (size < 5 || end > this.bytes.length || this.bytes[end - 1] !== 0) {
      throw broken('a document has a wrong size');
    }
    const fields: MongoField[] = [];
    let at = offset + 4;
    while (at < end - 1) {
      const type = this.bytes[at] ?? 0;
      const name = this.cstring(at + 1);
      const read = this.value(type, name.end, depth);
      fields.push([name.text, read.value]);
      at = read.end;
    }
    if (at !== end - 1) {
      throw broken('a field runs past its document');
    }
    return { document: { type: 'document', fields }, end };
  }

  private value(type: number, at: number, depth: number): { value: MongoValue; end: number } {
    switch (type) {
      case 0x01: {
        const number = this.view.getFloat64(this.check(at, 8), true);
        return { value: doubleValue(number), end: at + 8 };
      }
      case 0x02: {
        const text = this.string(at);
        return { value: { type: 'string', value: text.text }, end: text.end };
      }
      case 0x03:
        return this.wrap(this.document(at, depth + 1));
      case 0x04: {
        const read = this.document(at, depth + 1);
        return {
          value: { type: 'array', items: read.document.fields.map(([, item]) => item) },
          end: read.end,
        };
      }
      case 0x05: {
        const length = this.int32(at);
        const subtype = this.byte(at + 4);
        let start = at + 5;
        let size = length;
        // The old binary subtype carries its length once more; bson writes it back.
        if (subtype === 0x02 && length >= 4) {
          start += 4;
          size -= 4;
        }
        const data = this.slice(start, size);
        return {
          value: { type: 'binary', subtype, value: Buffer.from(data).toString('base64') },
          end: at + 5 + length,
        };
      }
      case 0x06:
        return { value: { type: 'undefined' }, end: at };
      case 0x07:
        return {
          value: { type: 'objectId', value: Buffer.from(this.slice(at, 12)).toString('hex') },
          end: at + 12,
        };
      case 0x08:
        return { value: { type: 'bool', value: this.byte(at) !== 0 }, end: at + 1 };
      case 0x09:
        return {
          value: { type: 'date', value: this.view.getBigInt64(this.check(at, 8), true).toString() },
          end: at + 8,
        };
      case 0x0a:
        return { value: { type: 'null' }, end: at };
      case 0x0b: {
        const pattern = this.cstring(at);
        const flags = this.cstring(pattern.end);
        return {
          value: { type: 'regex', pattern: pattern.text, flags: flags.text },
          end: flags.end,
        };
      }
      case 0x0c: {
        const ns = this.string(at);
        return {
          value: {
            type: 'dbPointer',
            ns: ns.text,
            id: Buffer.from(this.slice(ns.end, 12)).toString('hex'),
          },
          end: ns.end + 12,
        };
      }
      case 0x0d: {
        const code = this.string(at);
        return { value: { type: 'code', value: code.text }, end: code.end };
      }
      case 0x0e: {
        const symbol = this.string(at);
        return { value: { type: 'symbol', value: symbol.text }, end: symbol.end };
      }
      case 0x0f: {
        const size = this.int32(at);
        const code = this.string(at + 4);
        const scope = this.document(code.end, depth + 1);
        return {
          value: { type: 'code', value: code.text, scope: scope.document },
          end: at + size,
        };
      }
      case 0x10:
        return { value: { type: 'int32', value: this.int32(at) }, end: at + 4 };
      case 0x11: {
        const i = this.view.getUint32(this.check(at, 8), true);
        const t = this.view.getUint32(at + 4, true);
        return { value: { type: 'timestamp', t, i }, end: at + 8 };
      }
      case 0x12:
        return {
          value: {
            type: 'int64',
            value: this.view.getBigInt64(this.check(at, 8), true).toString(),
          },
          end: at + 8,
        };
      case 0x13:
        return {
          value: {
            type: 'decimal',
            value: new Decimal128(Buffer.from(this.slice(at, 16))).toString(),
          },
          end: at + 16,
        };
      case 0xff:
        return { value: { type: 'minKey' }, end: at };
      case 0x7f:
        return { value: { type: 'maxKey' }, end: at };
      default:
        throw broken(`it holds an unknown type 0x${type.toString(16)}`);
    }
  }

  private wrap(read: { document: MongoDocument; end: number }): { value: MongoValue; end: number } {
    return { value: read.document, end: read.end };
  }

  private check(at: number, size: number): number {
    if (at < 0 || at + size > this.bytes.length) {
      throw broken('a value runs past the end');
    }
    return at;
  }

  private byte(at: number): number {
    return this.bytes[this.check(at, 1)] ?? 0;
  }

  private int32(at: number): number {
    return this.view.getInt32(this.check(at, 4), true);
  }

  private slice(at: number, size: number): Uint8Array {
    if (size < 0) {
      throw broken('a value has a negative size');
    }
    return this.bytes.subarray(this.check(at, size), at + size);
  }

  private cstring(at: number): { text: string; end: number } {
    const zero = this.bytes.indexOf(0, at);
    if (zero < 0) {
      throw broken('a name has no end');
    }
    return { text: UTF8.decode(this.bytes.subarray(at, zero)), end: zero + 1 };
  }

  /** A length-prefixed string; the length counts its closing zero. */
  private string(at: number): { text: string; end: number } {
    const length = this.int32(at);
    if (length < 1 || this.byte(at + 4 + length - 1) !== 0) {
      throw broken('a string has a wrong size');
    }
    return {
      text: UTF8.decode(this.bytes.subarray(at + 4, at + 4 + length - 1)),
      end: at + 4 + length,
    };
  }
}

function broken(why: string): DbError {
  return new DbError('internal', `The server sent a document DataNest cannot read: ${why}`);
}

/** A double as text; `-0` keeps its sign, which `String` drops. */
export function doubleValue(number: number): MongoValue {
  return { type: 'double', value: Object.is(number, -0) ? '-0' : String(number) };
}

/** One BSON document, as the bytes order its fields. */
export function readBson(bytes: Uint8Array): MongoDocument {
  const read = new Reader(bytes).document(0, 0);
  if (read.end !== bytes.length) {
    throw broken('there are bytes after the document');
  }
  return read.document;
}

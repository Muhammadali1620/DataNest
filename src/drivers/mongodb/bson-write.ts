// MongoValue ⇄ the values the `mongodb` driver serializes (V7.5, D88). Documents
// become `Map`s, which `bson` writes in insertion order: a plain object would move a
// field called "12" to the front. Replies of commands come back as the driver read
// them, with `promoteValues: false`, so int32, double and int64 stay apart.

import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from 'mongodb';
import { DbError } from '../../core/errors';
import type { MongoDocument, MongoField, MongoValue } from '../../core/mongo/value';
import { doubleValue } from './bson-read';

/** The furthest a JavaScript `Date` reaches either side of 1970. */
const MAX_DATE_MS = 8.64e15;

/** A value the driver can serialize, field order kept. */
export function toDriverValue(value: MongoValue): unknown {
  switch (value.type) {
    case 'document':
      return toDriverDocument(value);
    case 'array':
      return value.items.map((item) => toDriverValue(item));
    case 'null':
    case 'undefined':
      // BSON's undefined is deprecated; the driver writes it as null as well.
      return null;
    case 'bool':
      return value.value;
    case 'int32':
      return new Int32(value.value);
    case 'int64':
      return Long.fromString(value.value);
    case 'double':
      return new Double(Number(value.value));
    case 'decimal':
      return Decimal128.fromString(value.value);
    case 'string':
      return value.value;
    case 'objectId':
      return ObjectId.createFromHexString(value.value);
    case 'date': {
      const ms = Number(value.value);
      if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_DATE_MS) {
        throw new DbError(
          'unsupported',
          `The date ${value.value} ms is out of the range DataNest can write`,
        );
      }
      return new Date(ms);
    }
    case 'binary':
      return new Binary(Buffer.from(value.value, 'base64'), value.subtype);
    case 'regex':
      return new BSONRegExp(value.pattern, value.flags);
    case 'timestamp':
      return new Timestamp({ t: value.t, i: value.i });
    case 'minKey':
      return new MinKey();
    case 'maxKey':
      return new MaxKey();
    case 'code':
      return new Code(
        value.value,
        value.scope === undefined ? null : Object.fromEntries(toDriverDocument(value.scope)),
      );
    case 'symbol':
      return new BSONSymbol(value.value);
    case 'dbPointer':
      // The driver cannot write the deprecated pointer type; a DBRef says the same.
      return new DBRef(value.ns, ObjectId.createFromHexString(value.id));
  }
}

export function toDriverDocument(document: MongoDocument): Map<string, unknown> {
  return new Map(document.fields.map(([name, value]) => [name, toDriverValue(value)]));
}

/**
 * A command for `db.command`: a plain object at the top, because the driver adds its
 * own fields (`$db`, `lsid`) to it; the command's name stays first and nested
 * documents are `Map`s.
 */
export function toDriverCommand(command: MongoDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of command.fields) {
    out[name] = toDriverValue(value);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Most nested levels a reply is followed into. */
const MAX_DEPTH = 200;

/** A value the driver read (bson classes, Dates, Buffers, objects) as a MongoValue. */
export function fromDriverValue(value: unknown, depth = 0): MongoValue {
  if (depth > MAX_DEPTH) {
    throw new DbError('internal', 'The reply nests too deeply');
  }
  if (value === null) {
    return { type: 'null' };
  }
  if (value === undefined) {
    return { type: 'undefined' };
  }
  if (typeof value === 'boolean') {
    return { type: 'bool', value };
  }
  if (typeof value === 'string') {
    return { type: 'string', value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) &&
      value >= -2_147_483_648 &&
      value <= 2_147_483_647 &&
      !Object.is(value, -0)
      ? { type: 'int32', value }
      : doubleValue(value);
  }
  if (typeof value === 'bigint') {
    return { type: 'int64', value: value.toString() };
  }
  if (value instanceof Date) {
    return { type: 'date', value: String(value.getTime()) };
  }
  if (value instanceof RegExp) {
    return { type: 'regex', pattern: value.source, flags: value.flags };
  }
  if (value instanceof Uint8Array) {
    return { type: 'binary', subtype: 0, value: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return { type: 'array', items: value.map((item: unknown) => fromDriverValue(item, depth + 1)) };
  }
  if (value instanceof Map) {
    return {
      type: 'document',
      fields: [...(value as Map<string, unknown>).entries()].map(([name, item]): MongoField => [
        name,
        fromDriverValue(item, depth + 1),
      ]),
    };
  }
  if (!isRecord(value)) {
    // A symbol or a function: nothing BSON has; show what it is rather than fail.
    return { type: 'string', value: Object.prototype.toString.call(value) };
  }
  switch (value._bsontype) {
    case 'Int32':
      return { type: 'int32', value: (value as unknown as Int32).value };
    case 'Double':
      return doubleValue((value as unknown as Double).value);
    case 'Long':
      return { type: 'int64', value: (value as unknown as Long).toString() };
    case 'Decimal128':
      return { type: 'decimal', value: (value as unknown as Decimal128).toString() };
    case 'ObjectId':
      return { type: 'objectId', value: (value as unknown as ObjectId).toHexString() };
    case 'Binary': {
      const binary = value as unknown as Binary;
      return {
        type: 'binary',
        subtype: binary.sub_type,
        value: Buffer.from(binary.buffer).toString('base64'),
      };
    }
    case 'BSONRegExp': {
      const regex = value as unknown as BSONRegExp;
      return { type: 'regex', pattern: regex.pattern, flags: regex.options };
    }
    case 'Timestamp': {
      const timestamp = value as unknown as Timestamp;
      return { type: 'timestamp', t: timestamp.t, i: timestamp.i };
    }
    case 'MinKey':
      return { type: 'minKey' };
    case 'MaxKey':
      return { type: 'maxKey' };
    case 'Code': {
      const code = value as unknown as Code;
      return code.scope === null
        ? { type: 'code', value: code.code }
        : {
            type: 'code',
            value: code.code,
            scope: fromDriverDocument(code.scope, depth + 1),
          };
    }
    case 'BSONSymbol':
      return { type: 'symbol', value: (value as unknown as BSONSymbol).value };
    case 'DBRef': {
      const ref = value as unknown as DBRef;
      return {
        type: 'document',
        fields: [
          ['$ref', { type: 'string', value: ref.collection }],
          ['$id', fromDriverValue(ref.oid, depth + 1)],
          ...(ref.db === undefined || ref.db === ''
            ? []
            : ([['$db', { type: 'string', value: ref.db }]] as MongoField[])),
        ],
      };
    }
    default:
      return fromDriverDocument(value, depth);
  }
}

export function fromDriverDocument(value: Record<string, unknown>, depth = 0): MongoDocument {
  return {
    type: 'document',
    fields: Object.entries(value).map(([name, item]): MongoField => [
      name,
      fromDriverValue(item, depth + 1),
    ]),
  };
}

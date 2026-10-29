// A BSON value as plain data (V7.5, D88): what the MongoDB driver reads and writes and
// what DataNest shows, edits and parses. Plain objects, not the `bson` classes: the
// driver is a bundle of its own (D82), and a document must keep its field order, which
// a JavaScript object loses for names like "12".

/** A document: fields in the order the server keeps them; a name may repeat in BSON. */
export interface MongoDocument {
  readonly type: 'document';
  readonly fields: readonly MongoField[];
}

export type MongoField = readonly [name: string, value: MongoValue];

export type MongoValue =
  | MongoDocument
  | { readonly type: 'array'; readonly items: readonly MongoValue[] }
  | { readonly type: 'null' }
  | { readonly type: 'undefined' }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'int32'; readonly value: number }
  /** 64-bit integers and dates as decimal text: a double would round them (D24). */
  | { readonly type: 'int64'; readonly value: string }
  /** A double as text, so `NaN`, `Infinity`, `-Infinity` and `-0` travel as JSON. */
  | { readonly type: 'double'; readonly value: string }
  | { readonly type: 'decimal'; readonly value: string }
  | { readonly type: 'string'; readonly value: string }
  /** 24 lowercase hex digits. */
  | { readonly type: 'objectId'; readonly value: string }
  /** Milliseconds since 1970 in UTC, as decimal text. */
  | { readonly type: 'date'; readonly value: string }
  /** Bytes in base64; subtype 4 is a UUID. */
  | { readonly type: 'binary'; readonly subtype: number; readonly value: string }
  | { readonly type: 'regex'; readonly pattern: string; readonly flags: string }
  | { readonly type: 'timestamp'; readonly t: number; readonly i: number }
  | { readonly type: 'minKey' }
  | { readonly type: 'maxKey' }
  | { readonly type: 'code'; readonly value: string; readonly scope?: MongoDocument }
  /** Deprecated types, kept so that old data shows as it is. */
  | { readonly type: 'symbol'; readonly value: string }
  | { readonly type: 'dbPointer'; readonly ns: string; readonly id: string };

export type MongoValueType = MongoValue['type'];

export function doc(fields: readonly MongoField[]): MongoDocument {
  return { type: 'document', fields };
}

export function str(value: string): MongoValue {
  return { type: 'string', value };
}

export function int32(value: number): MongoValue {
  return { type: 'int32', value };
}

export function int64(value: string | number | bigint): MongoValue {
  return { type: 'int64', value: String(value) };
}

/** A double from a JavaScript number, keeping `-0`. */
export function double(value: number): MongoValue {
  return { type: 'double', value: Object.is(value, -0) ? '-0' : String(value) };
}

export function bool(value: boolean): MongoValue {
  return { type: 'bool', value };
}

export const NULL: MongoValue = { type: 'null' };

/** The value of the first field called `name`, or undefined. */
export function field(document: MongoDocument, name: string): MongoValue | undefined {
  return document.fields.find(([key]) => key === name)?.[1];
}

/** A text field's value, or undefined when it is missing or not text. */
export function stringField(document: MongoDocument, name: string): string | undefined {
  const value = field(document, name);
  return value?.type === 'string' ? value.value : undefined;
}

/** A numeric field as a JavaScript number, whatever its BSON type. */
export function numberField(document: MongoDocument, name: string): number | undefined {
  const value = field(document, name);
  return value === undefined ? undefined : toNumber(value);
}

/** A boolean field; numbers count as booleans the way the server reads them (`ok: 1`). */
export function boolField(document: MongoDocument, name: string): boolean | undefined {
  const value = field(document, name);
  if (value?.type === 'bool') {
    return value.value;
  }
  const number = value === undefined ? undefined : toNumber(value);
  return number === undefined ? undefined : number !== 0;
}

export function documentField(document: MongoDocument, name: string): MongoDocument | undefined {
  const value = field(document, name);
  return value?.type === 'document' ? value : undefined;
}

export function arrayField(
  document: MongoDocument,
  name: string,
): readonly MongoValue[] | undefined {
  const value = field(document, name);
  return value?.type === 'array' ? value.items : undefined;
}

/** Any number as a JavaScript number (64-bit ones may round); undefined for the rest. */
export function toNumber(value: MongoValue): number | undefined {
  if (value.type === 'int32') {
    return value.value;
  }
  if (value.type !== 'int64' && value.type !== 'double' && value.type !== 'decimal') {
    return undefined;
  }
  const number = Number(value.value);
  return Number.isNaN(number) && value.value !== 'NaN' ? undefined : number;
}

/** True when both values are the same BSON, field order included. */
export function sameValue(a: MongoValue, b: MongoValue): boolean {
  switch (a.type) {
    case 'document':
      return (
        b.type === 'document' &&
        a.fields.length === b.fields.length &&
        a.fields.every(([name, value], index) => {
          const other = b.fields[index];
          return other?.[0] === name && sameValue(value, other[1]);
        })
      );
    case 'array':
      return (
        b.type === 'array' &&
        a.items.length === b.items.length &&
        a.items.every((item, index) => {
          const other = b.items[index];
          return other !== undefined && sameValue(item, other);
        })
      );
    case 'null':
    case 'undefined':
    case 'minKey':
    case 'maxKey':
      return b.type === a.type;
    case 'bool':
    case 'int32':
    case 'int64':
    case 'double':
    case 'decimal':
    case 'string':
    case 'objectId':
    case 'date':
    case 'symbol':
      return b.type === a.type && b.value === a.value;
    case 'binary':
      return b.type === 'binary' && b.subtype === a.subtype && b.value === a.value;
    case 'regex':
      return b.type === 'regex' && b.pattern === a.pattern && b.flags === a.flags;
    case 'timestamp':
      return b.type === 'timestamp' && b.t === a.t && b.i === a.i;
    case 'code':
      return (
        b.type === 'code' &&
        b.value === a.value &&
        (a.scope === undefined
          ? b.scope === undefined
          : b.scope !== undefined && sameValue(a.scope, b.scope))
      );
    case 'dbPointer':
      return b.type === 'dbPointer' && b.ns === a.ns && b.id === a.id;
  }
}

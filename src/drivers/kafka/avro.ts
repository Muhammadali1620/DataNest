// Avro binary decoding (V13.34), written here because no Avro library may come in: the
// messages of a topic that uses a schema registry carry their data in Avro, and the page
// shows them as JSON. Only reading is done: the decoder follows the schema the registry
// gave for the id in the message. Logical types (decimal, dates) show as what they are
// stored as; a `long` outside the safe integer range shows as a string.

const MAX_DEPTH = 64;
const MAX_ITEMS = 1_000_000;

export type AvroType =
  | { kind: 'null' | 'boolean' | 'int' | 'long' | 'float' | 'double' | 'bytes' | 'string' }
  | { kind: 'record'; fields: { name: string; type: AvroType }[] }
  | { kind: 'enum'; symbols: string[] }
  | { kind: 'array'; items: AvroType }
  | { kind: 'map'; values: AvroType }
  | { kind: 'fixed'; size: number }
  | { kind: 'union'; branches: AvroType[] };

const PRIMITIVES = new Set([
  'null',
  'boolean',
  'int',
  'long',
  'float',
  'double',
  'bytes',
  'string',
]);

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Turns the schema's JSON into a tree the decoder walks; names are resolved on the way. */
export function parseAvroSchema(schema: unknown): AvroType {
  const named = new Map<string, AvroType>();
  const build = (node: unknown, namespace: string, depth: number): AvroType => {
    if (depth > MAX_DEPTH) {
      fail('The Avro schema is nested too deeply');
    }
    if (typeof node === 'string') {
      if (PRIMITIVES.has(node)) {
        return { kind: node } as AvroType;
      }
      const found = named.get(node) ?? named.get(`${namespace}.${node}`);
      return found ?? fail(`The Avro schema names an unknown type "${node}"`);
    }
    if (Array.isArray(node)) {
      return { kind: 'union', branches: node.map((one) => build(one, namespace, depth + 1)) };
    }
    if (!isObject(node)) {
      return fail('The Avro schema is not valid');
    }
    const type = node.type;
    const nameOf = (): { full: string; space: string } => {
      const name = typeof node.name === 'string' ? node.name : fail('A type has no name');
      const own = typeof node.namespace === 'string' ? node.namespace : undefined;
      if (name.includes('.')) {
        return { full: name, space: name.slice(0, name.lastIndexOf('.')) };
      }
      const space = own ?? namespace;
      return { full: space === '' ? name : `${space}.${name}`, space };
    };
    switch (type) {
      case 'record':
      case 'error': {
        const { full, space } = nameOf();
        const record: AvroType = { kind: 'record', fields: [] };
        named.set(full, record);
        const fields = Array.isArray(node.fields) ? node.fields : [];
        for (const field of fields) {
          if (!isObject(field) || typeof field.name !== 'string') {
            fail('A record field has no name');
          }
          record.fields.push({
            name: field.name,
            type: build(field.type, space, depth + 1),
          });
        }
        return record;
      }
      case 'enum': {
        const { full } = nameOf();
        const symbols = Array.isArray(node.symbols) ? node.symbols.map(String) : [];
        const result: AvroType = { kind: 'enum', symbols };
        named.set(full, result);
        return result;
      }
      case 'fixed': {
        const { full } = nameOf();
        const size = typeof node.size === 'number' ? node.size : fail('A fixed has no size');
        const result: AvroType = { kind: 'fixed', size };
        named.set(full, result);
        return result;
      }
      case 'array':
        return { kind: 'array', items: build(node.items, namespace, depth + 1) };
      case 'map':
        return { kind: 'map', values: build(node.values, namespace, depth + 1) };
      default:
        // {"type": "string", "logicalType": …}, or {"type": {…}}.
        return build(type, namespace, depth + 1);
    }
  };
  return build(schema, '', 0);
}

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  take(count: number): Uint8Array {
    if (count < 0 || this.pos + count > this.bytes.length) {
      fail('The message ends before the schema says it should');
    }
    const slice = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }

  byte(): number {
    return this.take(1)[0] ?? 0;
  }

  /** A zig-zag varint, as a bigint (an `int` and a `long` are coded the same way). */
  long(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      const next = this.byte();
      result |= BigInt(next & 0x7f) << shift;
      if ((next & 0x80) === 0) {
        return (result >> 1n) ^ -(result & 1n);
      }
      shift += 7n;
    }
    return fail('A number in the message is too long');
  }

  count(): number {
    const value = this.long();
    if (value < 0n || value > BigInt(MAX_ITEMS)) {
      fail('A length in the message is out of range');
    }
    return Number(value);
  }
}

function numberOf(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function decode(type: AvroType, reader: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    fail('The message is nested too deeply');
  }
  switch (type.kind) {
    case 'null':
      return null;
    case 'boolean':
      return reader.byte() !== 0;
    case 'int':
    case 'long':
      return numberOf(reader.long());
    case 'float': {
      const bytes = reader.take(4);
      return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
    }
    case 'double': {
      const bytes = reader.take(8);
      return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
    }
    case 'string':
      return Buffer.from(reader.take(reader.count())).toString('utf8');
    case 'bytes':
      return Buffer.from(reader.take(reader.count())).toString('base64');
    case 'fixed':
      return Buffer.from(reader.take(type.size)).toString('base64');
    case 'enum': {
      const index = Number(reader.long());
      return type.symbols[index] ?? fail('The message names an enum symbol that is not there');
    }
    case 'union': {
      const index = Number(reader.long());
      const branch =
        type.branches[index] ?? fail('The message names a union branch that is not there');
      return decode(branch, reader, depth + 1);
    }
    case 'record': {
      const record: Record<string, unknown> = {};
      for (const field of type.fields) {
        record[field.name] = decode(field.type, reader, depth + 1);
      }
      return record;
    }
    case 'array': {
      const items: unknown[] = [];
      for (;;) {
        let block = reader.long();
        if (block === 0n) {
          return items;
        }
        if (block < 0n) {
          block = -block;
          reader.long(); // the block's size in bytes: not needed
        }
        if (items.length + Number(block) > MAX_ITEMS) {
          fail('An array in the message is too long');
        }
        for (let index = 0n; index < block; index += 1n) {
          items.push(decode(type.items, reader, depth + 1));
        }
      }
    }
    case 'map': {
      const map: Record<string, unknown> = {};
      for (;;) {
        let block = reader.long();
        if (block === 0n) {
          return map;
        }
        if (block < 0n) {
          block = -block;
          reader.long();
        }
        for (let index = 0n; index < block; index += 1n) {
          const key = Buffer.from(reader.take(reader.count())).toString('utf8');
          map[key] = decode(type.values, reader, depth + 1);
        }
      }
    }
  }
}

/** Reads one value of `type` from `bytes`; the bytes must be used up (a wrong schema shows). */
export function decodeAvro(type: AvroType, bytes: Uint8Array): unknown {
  const reader = new Reader(bytes);
  const value = decode(type, reader, 0);
  if (reader.pos !== bytes.length) {
    fail('The message has bytes left over after the schema');
  }
  return value;
}

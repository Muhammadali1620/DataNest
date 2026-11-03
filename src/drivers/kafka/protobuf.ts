// Protobuf decoding by the `.proto` text the schema registry keeps (V13.34). A small parser
// reads what a message needs (messages, nested messages, enums, `repeated`, `map<,>`,
// `oneof`); options are skipped. Imports are read by the registry client, which adds the types
// of the imported files; a field whose type still cannot be found is shown by its number with
// the plain wire value. Only reading is done. The message is chosen by the index path that the Confluent wire format carries.

const MAX_DEPTH = 32;

const SCALARS = new Set([
  'double',
  'float',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'bool',
  'string',
  'bytes',
]);

interface Field {
  name: string;
  number: number;
  type: string;
  repeated: boolean;
  /** Set for `map<K, V>`: the key type; `type` is then the value type. */
  mapKey?: string;
}

interface MessageDef {
  name: string;
  fullName: string;
  fields: Map<number, Field>;
  /** Nested messages in the order they are written (the index path counts them). */
  children: MessageDef[];
}

export interface ProtoFile {
  messages: MessageDef[];
  /** Every message and enum by full name (`pkg.Outer.Inner`). */
  byName: Map<string, MessageDef | EnumDef>;
}

interface EnumDef {
  enumName: string;
  values: Map<number, string>;
}

function fail(message: string): never {
  throw new Error(message);
}

function tokens(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][\w.]*|-?\d+|[{}[\]();=<>,]/gu;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    if (!token.startsWith('//') && !token.startsWith('/*')) {
      found.push(token);
    }
  }
  return found;
}

/**
 * The well-known types that schemas import (`google/protobuf/*.proto`). A registry may or may
 * not list them among a schema's references, so they are always known here.
 */
const WELL_KNOWN_PROTO = `
syntax = "proto3";
package google.protobuf;
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
message Duration { int64 seconds = 1; int32 nanos = 2; }
message Empty {}
message Any { string type_url = 1; bytes value = 2; }
message FieldMask { repeated string paths = 1; }
message DoubleValue { double value = 1; }
message FloatValue { float value = 1; }
message Int64Value { int64 value = 1; }
message UInt64Value { uint64 value = 1; }
message Int32Value { int32 value = 1; }
message UInt32Value { uint32 value = 1; }
message BoolValue { bool value = 1; }
message StringValue { string value = 1; }
message BytesValue { bytes value = 1; }
`;

/** The file names (as written in an `import`) that the built-in well-known types stand for. */
export function isWellKnownImport(name: string): boolean {
  return /^google\/protobuf\/(timestamp|duration|empty|any|field_mask|wrappers)\.proto$/u.test(
    name,
  );
}

/**
 * Makes the types of `extra` known to `file`, so a field of an imported type decodes as that
 * type. A name `file` already has is kept (the schema's own wins over an import).
 */
export function addTypes(file: ProtoFile, extra: ProtoFile): void {
  for (const [name, def] of extra.byName) {
    if (!file.byName.has(name)) {
      file.byName.set(name, def);
    }
  }
}

/** Adds the built-in well-known types to a file. */
export function addWellKnownTypes(file: ProtoFile): void {
  addTypes(file, parseProto(WELL_KNOWN_PROTO));
}

/** Reads the messages and enums of a `.proto` text. */
export function parseProto(text: string): ProtoFile {
  const all = tokens(text);
  let at = 0;
  let pkg = '';
  const byName = new Map<string, MessageDef | EnumDef>();
  const peek = (): string => all[at] ?? '';
  const next = (): string => all[at++] ?? fail('The .proto text ends too early');
  const skipStatement = (): void => {
    let depth = 0;
    while (at < all.length) {
      const token = next();
      if (token === '{' || token === '[') {
        depth += 1;
      } else if (token === '}' || token === ']') {
        depth -= 1;
      } else if (token === ';' && depth <= 0) {
        return;
      }
      if (token === '}' && depth <= 0) {
        return;
      }
    }
  };
  const skipBlock = (): void => {
    let depth = 0;
    do {
      const token = next();
      depth += token === '{' ? 1 : token === '}' ? -1 : 0;
    } while (depth > 0 && at < all.length);
  };

  const parseEnum = (scope: string): void => {
    const name = next();
    const enumDef: EnumDef = { enumName: name, values: new Map() };
    byName.set(scope === '' ? name : `${scope}.${name}`, enumDef);
    next(); // {
    while (peek() !== '}' && at < all.length) {
      const key = next();
      if (key === 'option' || key === 'reserved') {
        skipStatement();
        continue;
      }
      if (next() !== '=') {
        fail('An enum value has no number');
      }
      enumDef.values.set(Number(next()), key);
      skipStatement();
    }
    next(); // }
  };

  const parseMessage = (scope: string, depth: number): MessageDef => {
    if (depth > MAX_DEPTH) {
      fail('The .proto text is nested too deeply');
    }
    const name = next();
    const fullName = scope === '' ? name : `${scope}.${name}`;
    const def: MessageDef = { name, fullName, fields: new Map(), children: [] };
    byName.set(fullName, def);
    next(); // {
    const readField = (first: string): void => {
      let repeated = false;
      let type = first;
      if (type === 'repeated') {
        repeated = true;
        type = next();
      } else if (type === 'optional' || type === 'required') {
        type = next();
      }
      let mapKey: string | undefined;
      if (type === 'map') {
        next(); // <
        mapKey = next();
        next(); // ,
        type = next();
        next(); // >
      }
      const fieldName = next();
      if (next() !== '=') {
        fail('A field has no number');
      }
      const number = Number(next());
      def.fields.set(number, {
        name: fieldName,
        number,
        type,
        repeated,
        ...(mapKey === undefined ? {} : { mapKey }),
      });
      skipStatement();
    };
    while (peek() !== '}' && at < all.length) {
      const token = next();
      switch (token) {
        case 'message':
          def.children.push(parseMessage(fullName, depth + 1));
          break;
        case 'enum':
          parseEnum(fullName);
          break;
        case 'oneof': {
          next(); // name
          next(); // {
          while (peek() !== '}' && at < all.length) {
            const first = next();
            if (first === 'option') {
              skipStatement();
            } else {
              readField(first);
            }
          }
          next(); // }
          break;
        }
        case 'option':
        case 'reserved':
        case 'extensions':
        case 'extend':
          if (token === 'extend') {
            next();
            skipBlock();
          } else {
            skipStatement();
          }
          break;
        case ';':
          break;
        default:
          readField(token);
      }
    }
    next(); // }
    return def;
  };

  const messages: MessageDef[] = [];
  while (at < all.length) {
    const token = next();
    if (token === 'package') {
      pkg = next();
      skipStatement();
    } else if (token === 'message') {
      messages.push(parseMessage(pkg, 0));
    } else if (token === 'enum') {
      parseEnum(pkg);
    } else if (token === 'service') {
      next();
      skipBlock();
    } else {
      skipStatement();
    }
  }
  return { messages, byName };
}

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  take(count: number): Uint8Array {
    if (count < 0 || this.pos + count > this.bytes.length) {
      fail('The message ends before its fields do');
    }
    const slice = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      const next = this.take(1)[0] ?? 0;
      result |= BigInt(next & 0x7f) << shift;
      if ((next & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }
    return fail('A number in the message is too long');
  }
}

function safe(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function scalarOfVarint(type: string, raw: bigint): unknown {
  switch (type) {
    case 'bool':
      return raw !== 0n;
    case 'int32':
      return Number(BigInt.asIntN(32, raw));
    case 'int64':
      return safe(BigInt.asIntN(64, raw));
    case 'uint32':
      return Number(BigInt.asUintN(32, raw));
    case 'uint64':
      return safe(BigInt.asUintN(64, raw));
    case 'sint32':
    case 'sint64': {
      const value = (raw >> 1n) ^ -(raw & 1n);
      return type === 'sint32' ? Number(BigInt.asIntN(32, value)) : safe(BigInt.asIntN(64, value));
    }
    default:
      return safe(raw);
  }
}

function plain(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fixed(type: string, bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  switch (type) {
    case 'float':
      return view.getFloat32(0, true);
    case 'double':
      return view.getFloat64(0, true);
    case 'fixed32':
      return view.getUint32(0, true);
    case 'sfixed32':
      return view.getInt32(0, true);
    case 'fixed64':
      return safe(view.getBigUint64(0, true));
    case 'sfixed64':
      return safe(view.getBigInt64(0, true));
    default:
      return Buffer.from(bytes).toString('base64');
  }
}

const VARINT_TYPES = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool']);
const FIXED32 = new Set(['float', 'fixed32', 'sfixed32']);
const FIXED64 = new Set(['double', 'fixed64', 'sfixed64']);

class Decoder {
  constructor(private readonly file: ProtoFile) {}

  /** Finds a type by name from the scope it is written in, the way protoc does. */
  resolve(name: string, scope: string): MessageDef | EnumDef | undefined {
    let search = scope;
    for (;;) {
      const found = this.file.byName.get(search === '' ? name : `${search}.${name}`);
      if (found !== undefined) {
        return found;
      }
      if (search === '') {
        return undefined;
      }
      const cut = search.lastIndexOf('.');
      search = cut < 0 ? '' : search.slice(0, cut);
    }
  }

  message(def: MessageDef | undefined, bytes: Uint8Array, depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) {
      fail('The message is nested too deeply');
    }
    const reader = new Reader(bytes);
    const out: Record<string, unknown> = {};
    while (!reader.done) {
      const key = Number(reader.varint());
      const number = key >>> 3;
      const wire = key & 7;
      const field = def?.fields.get(number);
      const name = field?.name ?? String(number);
      const scope = def === undefined ? '' : def.fullName;
      let value: unknown;
      switch (wire) {
        case 0:
          value = this.varintValue(field, scope, reader.varint());
          break;
        case 1: {
          const raw = reader.take(8);
          value = FIXED64.has(field?.type ?? '') ? fixed(field?.type ?? '', raw) : plain(raw);
          break;
        }
        case 2:
          value = this.lengthValue(field, scope, reader.take(Number(reader.varint())), depth);
          break;
        case 5: {
          const raw = reader.take(4);
          value = FIXED32.has(field?.type ?? '') ? fixed(field?.type ?? '', raw) : plain(raw);
          break;
        }
        default:
          return fail('The message uses a field coding that is not supported');
      }
      if (field?.mapKey !== undefined && isRecord(value)) {
        const target = (out[name] ??= {}) as Record<string, unknown>;
        target[String(value.key)] = value.value;
      } else if (field?.repeated === true) {
        const list = (out[name] ??= []) as unknown[];
        if (Array.isArray(value) && wire === 2 && this.packed(field.type)) {
          list.push(...(value as unknown[]));
        } else {
          list.push(value);
        }
      } else {
        out[name] = value;
      }
    }
    return out;
  }

  private packed(type: string): boolean {
    return VARINT_TYPES.has(type) || FIXED32.has(type) || FIXED64.has(type);
  }

  private varintValue(field: Field | undefined, scope: string, raw: bigint): unknown {
    if (field === undefined) {
      return safe(raw);
    }
    if (VARINT_TYPES.has(field.type)) {
      return scalarOfVarint(field.type, raw);
    }
    const target = this.resolve(field.type, scope);
    if (target !== undefined && 'values' in target) {
      return target.values.get(Number(raw)) ?? Number(raw);
    }
    return safe(raw);
  }

  private lengthValue(
    field: Field | undefined,
    scope: string,
    bytes: Uint8Array,
    depth: number,
  ): unknown {
    if (field === undefined) {
      return Buffer.from(bytes).toString('base64');
    }
    if (field.mapKey !== undefined) {
      const entry = new Reader(bytes);
      const parts: Record<string, unknown> = {};
      while (!entry.done) {
        const key = Number(entry.varint());
        const wire = key & 7;
        const which = key >>> 3 === 1 ? 'key' : 'value';
        const type = which === 'key' ? (field.mapKey ?? 'string') : field.type;
        if (wire === 0) {
          parts[which] = this.varintValue({ ...field, type }, scope, entry.varint());
        } else if (wire === 2) {
          parts[which] = this.lengthValue(
            { ...field, type, mapKey: undefined, repeated: false },
            scope,
            entry.take(Number(entry.varint())),
            depth + 1,
          );
        } else {
          parts[which] = fixed(type, entry.take(wire === 5 ? 4 : 8));
        }
      }
      return parts;
    }
    if (field.type === 'string') {
      return Buffer.from(bytes).toString('utf8');
    }
    if (field.type === 'bytes') {
      return Buffer.from(bytes).toString('base64');
    }
    if (this.packed(field.type) && field.repeated) {
      const reader = new Reader(bytes);
      const list: unknown[] = [];
      while (!reader.done) {
        if (VARINT_TYPES.has(field.type)) {
          list.push(scalarOfVarint(field.type, reader.varint()));
        } else {
          list.push(fixed(field.type, reader.take(FIXED32.has(field.type) ? 4 : 8)));
        }
      }
      return list;
    }
    if (SCALARS.has(field.type)) {
      return Buffer.from(bytes).toString('base64');
    }
    const target = this.resolve(field.type, scope);
    if (target !== undefined && !('values' in target)) {
      return this.message(target, bytes, depth + 1);
    }
    return this.message(undefined, bytes, depth + 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message that a path of indexes names: the first among the top ones, then nested. */
export function messageAt(file: ProtoFile, path: readonly number[]): MessageDef {
  let list = file.messages;
  let found: MessageDef | undefined;
  for (const index of path) {
    found = list[index] ?? fail('The message index points at a message that is not there');
    list = found.children;
  }
  return found ?? fail('The message has no index');
}

/** Decodes one message of the file; `path` is the index path of the wire format. */
export function decodeProtobuf(
  file: ProtoFile,
  path: readonly number[],
  bytes: Uint8Array,
): unknown {
  return new Decoder(file).message(messageAt(file, path), bytes, 0);
}

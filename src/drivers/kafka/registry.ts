// A schema registry for Kafka (V13.34): the Confluent-compatible HTTP API that Confluent's
// own registry, Apicurio, Redpanda and others speak. A message written with a schema starts
// with a zero byte and the schema's id (4 bytes); the registry tells what the id means, and
// the data after it is Avro, Protobuf or JSON. Only reading is done, and a message the
// registry cannot explain stays as it is: the page never loses the bytes.

import { decodeAvro, parseAvroSchema, type AvroType } from './avro';
import { decodeProtobuf, parseProto, type ProtoFile } from './protobuf';

export type RegistryFormat = 'AVRO' | 'PROTOBUF' | 'JSON';

export interface RegistrySchema {
  readonly format: RegistryFormat;
  readonly text: string;
}

/** What the page shows next to a message that was decoded. */
export interface DecodedWire {
  readonly id: number;
  readonly format: RegistryFormat;
  /** The data as JSON text (JSON Schema data is passed on as it was written). */
  readonly bytes: Uint8Array;
}

export type RegistryFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const REQUEST_TIMEOUT_MS = 10_000;
/** How long a failed lookup is remembered, so a topic of unknown ids does not ask for each. */
const FAILURE_MEMORY_MS = 30_000;
const MAX_CACHED = 500;

interface Parsed {
  readonly format: RegistryFormat;
  readonly avro?: AvroType;
  readonly proto?: ProtoFile;
}

/** True when `text` is an address the registry client can use. */
export function isRegistryUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

function formatOf(type: unknown): RegistryFormat {
  switch (type) {
    case 'PROTOBUF':
      return 'PROTOBUF';
    case 'JSON':
      return 'JSON';
    default:
      return 'AVRO';
  }
}

/** Reads the index path of a Protobuf message (the zig-zag varints after the id). */
function protobufPath(bytes: Uint8Array, start: number): { path: number[]; next: number } {
  let at = start;
  const readInt = (): number => {
    let result = 0n;
    let shift = 0n;
    for (let index = 0; index < 5; index += 1) {
      const byte = bytes[at++];
      if (byte === undefined) {
        throw new Error('The message ends inside its header');
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return Number((result >> 1n) ^ -(result & 1n));
      }
      shift += 7n;
    }
    throw new Error('A number in the message header is too long');
  };
  const count = readInt();
  if (count === 0) {
    return { path: [0], next: at };
  }
  if (count < 0 || count > 32) {
    throw new Error('The message header names too many indexes');
  }
  const path: number[] = [];
  for (let index = 0; index < count; index += 1) {
    path.push(readInt());
  }
  return { path, next: at };
}

export class SchemaRegistry {
  private readonly found = new Map<number, Parsed>();
  private readonly failed = new Map<number, number>();
  private readonly base: string;

  constructor(
    url: string,
    private readonly fetcher: RegistryFetch,
    private readonly auth?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.base = url.replace(/\/+$/u, '');
  }

  /** Asks the registry for the schema of an id. */
  async schemaOf(id: number): Promise<RegistrySchema> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        accept: 'application/vnd.schemaregistry.v1+json, application/json',
      };
      if (this.auth !== undefined) {
        headers.authorization = this.auth;
      }
      const response = await this.fetcher(`${this.base}/schemas/ids/${id}`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`The registry answered ${response.status} for schema ${id}`);
      }
      const body = (await response.json()) as { schema?: unknown; schemaType?: unknown };
      if (typeof body.schema !== 'string') {
        throw new Error(`The registry sent no schema for ${id}`);
      }
      return { format: formatOf(body.schemaType), text: body.schema };
    } finally {
      clearTimeout(timer);
    }
  }

  private async parsed(id: number): Promise<Parsed> {
    const known = this.found.get(id);
    if (known !== undefined) {
      return known;
    }
    const failedAt = this.failed.get(id);
    if (failedAt !== undefined && this.now() - failedAt < FAILURE_MEMORY_MS) {
      throw new Error(`The schema ${id} could not be read a moment ago`);
    }
    try {
      const schema = await this.schemaOf(id);
      let parsed: Parsed;
      switch (schema.format) {
        case 'AVRO':
          parsed = { format: 'AVRO', avro: parseAvroSchema(JSON.parse(schema.text)) };
          break;
        case 'PROTOBUF':
          parsed = { format: 'PROTOBUF', proto: parseProto(schema.text) };
          break;
        case 'JSON':
          parsed = { format: 'JSON' };
          break;
      }
      if (this.found.size >= MAX_CACHED) {
        this.found.clear();
      }
      this.found.set(id, parsed);
      this.failed.delete(id);
      return parsed;
    } catch (error) {
      this.failed.set(id, this.now());
      throw error;
    }
  }

  /**
   * Decodes a message written with a schema; undefined when it is not one (no zero byte or
   * too short) or the registry cannot explain it, so the page then shows the bytes as they are.
   */
  async decode(bytes: Uint8Array): Promise<DecodedWire | undefined> {
    if (bytes.length < 5 || bytes[0] !== 0) {
      return undefined;
    }
    const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(1);
    try {
      const parsed = await this.parsed(id);
      const payload = bytes.subarray(5);
      let data: unknown;
      if (parsed.format === 'JSON') {
        return { id, format: 'JSON', bytes: payload };
      }
      if (parsed.format === 'AVRO' && parsed.avro !== undefined) {
        data = decodeAvro(parsed.avro, payload);
      } else if (parsed.proto !== undefined) {
        const { path, next } = protobufPath(bytes, 5);
        data = decodeProtobuf(parsed.proto, path, bytes.subarray(next));
      } else {
        return undefined;
      }
      return { id, format: parsed.format, bytes: Buffer.from(JSON.stringify(data), 'utf8') };
    } catch {
      return undefined;
    }
  }
}

/** The registry client over the global `fetch`. */
export const globalRegistryFetch: RegistryFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

/** The Basic header for a user and password; the registry shares the connection's sign-in. */
export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

// A schema registry for Kafka (V13.34): the Confluent-compatible HTTP API that Confluent's
// own registry, Apicurio, Redpanda and others speak. A message written with a schema starts
// with a zero byte and the schema's id (4 bytes); the registry tells what the id means, and
// the data after it is Avro, Protobuf or JSON. Only reading is done, and a message the
// registry cannot explain stays as it is: the page never loses the bytes.

import type { KafkaSettings } from '../../shared/connection';
import { decodeAvro, parseAvroSchema, type AvroType } from './avro';
import {
  addTypes,
  addWellKnownTypes,
  decodeProtobuf,
  isWellKnownImport,
  parseProto,
  type ProtoFile,
} from './protobuf';

export type RegistryFormat = 'AVRO' | 'PROTOBUF' | 'JSON';

/** A schema another one refers to: the subject and version it is kept under, and its import name. */
export interface RegistryReference {
  readonly name: string;
  readonly subject: string;
  readonly version: number;
}

export interface RegistrySchema {
  readonly format: RegistryFormat;
  readonly text: string;
  readonly references: readonly RegistryReference[];
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
/** A schema that imports others is followed this deep and this wide, so a loop or a flood ends. */
const MAX_REFERENCE_DEPTH = 8;
const MAX_REFERENCED_FILES = 40;

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

function referencesOf(value: unknown): RegistryReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const found: RegistryReference[] = [];
  for (const entry of value as unknown[]) {
    const item = entry as { name?: unknown; subject?: unknown; version?: unknown };
    if (
      typeof item.name === 'string' &&
      typeof item.subject === 'string' &&
      typeof item.version === 'number'
    ) {
      found.push({ name: item.name, subject: item.subject, version: item.version });
    }
  }
  return found;
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
    return await this.read(`/schemas/ids/${id}`, `schema ${id}`);
  }

  /** Asks for a schema by the subject and version a reference names. */
  async schemaOfSubject(subject: string, version: number): Promise<RegistrySchema> {
    return await this.read(
      `/subjects/${encodeURIComponent(subject)}/versions/${version}`,
      `schema ${subject} version ${version}`,
    );
  }

  private async read(path: string, what: string): Promise<RegistrySchema> {
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
      const response = await this.fetcher(`${this.base}${path}`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`The registry answered ${response.status} for ${what}`);
      }
      const body = (await response.json()) as {
        schema?: unknown;
        schemaType?: unknown;
        references?: unknown;
      };
      if (typeof body.schema !== 'string') {
        throw new Error(`The registry sent no ${what}`);
      }
      return {
        format: formatOf(body.schemaType),
        text: body.schema,
        references: referencesOf(body.references),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The types of the files a Protobuf schema imports: the references the registry lists, one
   * by one and the ones they list in turn. A file that cannot be read is left out, and its
   * fields then show by number like before.
   */
  private async withImports(file: ProtoFile, schema: RegistrySchema): Promise<void> {
    addWellKnownTypes(file);
    const seen = new Set<string>();
    let reads = 0;
    const follow = async (
      references: readonly RegistryReference[],
      depth: number,
    ): Promise<void> => {
      for (const reference of references) {
        const key = `${reference.subject}/${reference.version}`;
        if (
          seen.has(key) ||
          isWellKnownImport(reference.name) ||
          depth > MAX_REFERENCE_DEPTH ||
          reads >= MAX_REFERENCED_FILES
        ) {
          continue;
        }
        seen.add(key);
        reads += 1;
        try {
          const imported = await this.schemaOfSubject(reference.subject, reference.version);
          if (imported.format !== 'PROTOBUF') {
            continue;
          }
          addTypes(file, parseProto(imported.text));
          await follow(imported.references, depth + 1);
        } catch {
          // An import that cannot be read only costs the names of its types.
        }
      }
    };
    await follow(schema.references, 1);
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
          {
            const proto = parseProto(schema.text);
            await this.withImports(proto, schema);
            parsed = { format: 'PROTOBUF', proto };
          }
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

/** The Basic header for a user and password. */
export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * The `Authorization` header the registry is asked with (V13.41), or nothing for a registry
 * that needs no sign-in. By default (and when `registryAuth` is left out) it is the
 * connection's own user and password with Basic; `basic` uses a user of the registry's own
 * with `secret` as its password; `bearer` sends `secret` as a token. A choice of its own
 * without what it needs (no user, no token) signs in with nothing rather than with the
 * connection's login, which the registry was told not to get.
 */
export function registryAuthorization(
  kafka: KafkaSettings | undefined,
  login: { readonly user?: string; readonly password?: string },
  secret: string | undefined,
): string | undefined {
  const mode = kafka?.registryAuth ?? 'connection';
  if (mode === 'bearer') {
    return secret === undefined || secret === '' ? undefined : `Bearer ${secret}`;
  }
  if (mode === 'basic') {
    const user = kafka?.registryUser?.trim() ?? '';
    return user === '' ? undefined : basicAuth(user, secret ?? '');
  }
  const user = login.user?.trim() ?? '';
  return user === '' ? undefined : basicAuth(user, login.password ?? '');
}

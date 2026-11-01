// Keys of the RedisJSON module (V13.14), type `ReJSON-RL`. The page shows a document as a
// tree that opens one level at a time: a node is its JSONPath, kind and size, and its
// children are read when it is opened (`JSON.OBJKEYS`, `JSON.ARRLEN`), so a document of
// millions of members never travels whole. Numbers stay the text the server wrote.

import { DbError } from '../../core/errors';
import {
  formatJson,
  formatJsonLine,
  JsonSyntaxError,
  parseJson,
  previewJson,
} from '../../core/json/json-tree';
import { msg } from '../../core/user-message';
import type { RedisReply, RedisSession } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';
import { REDIS_JSON_TYPE } from '../../shared/protocols/redis-key';
import { replyItems, replyNumber, replyText } from './reply';

/** What `TYPE` says for a key of the module. */
export const JSON_KEY_TYPE = REDIS_JSON_TYPE;

export const JSON_ROOT = '$';

/** Children one page of an object or array holds. */
export const JSON_PAGE_SIZE = 200;
/** A document or part bigger than this (in memory) is not read whole into the page. */
export const MAX_JSON_READ_BYTES = 4 * 1024 * 1024;
/** Characters of the laid-out text the page gets; a longer one is cut. */
export const MAX_JSON_TEXT = 2_000_000;
/** A string longer than this shows its length instead of its start. */
const PREVIEW_STRING_MAX = 2000;
/** Characters of a value in a tree row. */
const PREVIEW_CHARS = 120;
/** Longest path the host accepts from the page. */
export const MAX_JSON_PATH = 10_000;

export type JsonKind = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

/** One row of the tree. */
export interface JsonNode {
  /** JSONPath of the node, always from `$`. */
  readonly path: string;
  /** The member name, or the position in an array; `$` for the root. */
  readonly label: string;
  /** What the server calls its type; the module may know more than {@link JsonKind}. */
  readonly kind: string;
  /** Members of an object, items of an array, characters of a string. */
  readonly size?: number;
  /** The value of a scalar, cut. */
  readonly preview?: string;
}

export interface JsonChildren {
  readonly nodes: JsonNode[];
  /** Children in all. */
  readonly total: number;
  readonly more: boolean;
}

export interface JsonText {
  readonly text: string;
  /** The text was cut at {@link MAX_JSON_TEXT}. */
  readonly truncated?: boolean;
  /** Bytes in memory when the part is too big to read whole. */
  readonly tooLarge?: number;
}

export function isJsonType(type: string): boolean {
  return type === JSON_KEY_TYPE;
}

/** The step into a member of an object: `$["name"]`, valid for any name. */
export function memberPath(parent: string, name: string): string {
  return `${parent}["${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
}

export function itemPath(parent: string, index: number): string {
  return `${parent}[${String(index)}]`;
}

function assertPath(path: string): void {
  if (!path.startsWith(JSON_ROOT) || path.length > MAX_JSON_PATH) {
    throw new DbError('unsupported', msg('Not a JSON path of this key'));
  }
}

/** The first element of an array reply of a `$` path (one match for a definite path). */
function first(reply: RedisReply | undefined): RedisReply {
  if (reply === undefined || isErrorReply(reply)) {
    return null;
  }
  return replyItems(reply)[0] ?? null;
}

function sizeOf(reply: RedisReply | undefined): number | undefined {
  const item = first(reply);
  return item === null ? undefined : replyNumber(item);
}

/** The value `JSON.GET key $` returns, as a tree: it is the value in an array of one. */
function valueOf(reply: RedisReply | undefined) {
  if (reply === undefined || isErrorReply(reply) || reply === null) {
    return undefined;
  }
  const parsed = parseJson(replyText(reply));
  return parsed.type === 'array' ? parsed.items[0] : undefined;
}

/** Rows for these paths: their types first, then sizes and the values of scalars. */
async function describe(
  session: RedisSession,
  key: Uint8Array,
  entries: readonly { readonly path: string; readonly label: string }[],
): Promise<JsonNode[]> {
  if (entries.length === 0) {
    return [];
  }
  const types = await session.pipeline(entries.map(({ path }) => ['JSON.TYPE', key, path]));
  const kinds = types.map((reply) => {
    const item = first(reply);
    return item === null ? undefined : replyText(item);
  });
  const second = await session.pipeline(
    entries.map(({ path }, index) => {
      switch (kinds[index]) {
        case 'object':
          return ['JSON.OBJLEN', key, path];
        case 'array':
          return ['JSON.ARRLEN', key, path];
        case 'string':
          return ['JSON.STRLEN', key, path];
        case undefined:
        default:
          return ['JSON.GET', key, path];
      }
    }),
  );
  // Short strings show their start; a long one only its length.
  const wanted = entries.flatMap((_entry, index) =>
    kinds[index] === 'string' && (sizeOf(second[index]) ?? 0) <= PREVIEW_STRING_MAX ? [index] : [],
  );
  const strings = await session.pipeline(
    wanted.map((index) => ['JSON.GET', key, entries[index]?.path ?? JSON_ROOT]),
  );
  return entries.map(({ path, label }, index) => {
    const kind = kinds[index];
    if (kind === undefined) {
      return { path, label, kind: 'null' };
    }
    if (kind === 'object' || kind === 'array') {
      const size = sizeOf(second[index]);
      return { path, label, kind, ...(size === undefined ? {} : { size }) };
    }
    const at = wanted.indexOf(index);
    const value =
      kind === 'string' ? valueOf(at === -1 ? undefined : strings[at]) : valueOf(second[index]);
    const size = kind === 'string' ? sizeOf(second[index]) : undefined;
    return {
      path,
      label,
      kind,
      ...(size === undefined ? {} : { size }),
      ...(value === undefined ? {} : { preview: previewJson(value, PREVIEW_CHARS) }),
    };
  });
}

/** The root of a key; throws when the module does not answer. */
export async function readJsonRoot(session: RedisSession, key: Uint8Array): Promise<JsonNode> {
  const type = first(await session.call(['JSON.TYPE', key, JSON_ROOT]));
  if (type === null) {
    throw new DbError('not-found', msg('The key has no JSON value'));
  }
  const [node] = await describe(session, key, [{ path: JSON_ROOT, label: JSON_ROOT }]);
  if (node === undefined) {
    throw new DbError('not-found', msg('The key has no JSON value'));
  }
  return node;
}

/**
 * A page of the children of an object or array: the members from `offset`, each as a
 * row. Anything else has none.
 */
export async function readJsonChildren(
  session: RedisSession,
  key: Uint8Array,
  path: string,
  offset: number,
  limit = JSON_PAGE_SIZE,
): Promise<JsonChildren> {
  assertPath(path);
  const type = first(await session.call(['JSON.TYPE', key, path]));
  if (type === null) {
    throw new DbError('not-found', msg('The path no longer exists: refresh the key'));
  }
  const kind = replyText(type);
  if (kind === 'array') {
    const total = sizeOf(await session.call(['JSON.ARRLEN', key, path])) ?? 0;
    const end = Math.min(total, offset + limit);
    const entries = [];
    for (let index = offset; index < end; index += 1) {
      entries.push({ path: itemPath(path, index), label: String(index) });
    }
    return { nodes: await describe(session, key, entries), total, more: end < total };
  }
  if (kind === 'object') {
    const names = replyItems(first(await session.call(['JSON.OBJKEYS', key, path]))).map(replyText);
    const slice = names.slice(offset, offset + limit);
    const nodes = await describe(
      session,
      key,
      slice.map((name) => ({ path: memberPath(path, name), label: name })),
    );
    return { nodes, total: names.length, more: offset + limit < names.length };
  }
  return { nodes: [], total: 0, more: false };
}

/** Part of the document laid out for reading; a part too big stays on the server. */
export async function readJsonText(
  session: RedisSession,
  key: Uint8Array,
  path: string,
): Promise<JsonText> {
  assertPath(path);
  // Not every build answers DEBUG; then the part is read as it is.
  const [memory] = await session.pipeline([['JSON.DEBUG', 'MEMORY', key, path]]);
  const bytes = sizeOf(memory);
  if (bytes !== undefined && bytes > MAX_JSON_READ_BYTES) {
    return { text: '', tooLarge: bytes };
  }
  const reply = await session.call(['JSON.GET', key, path]);
  const value = valueOf(reply);
  if (value === undefined) {
    throw new DbError('not-found', msg('The path no longer exists: refresh the key'));
  }
  const text = formatJson(value);
  return text.length > MAX_JSON_TEXT
    ? { text: text.slice(0, MAX_JSON_TEXT), truncated: true }
    : { text };
}

/** Replaces the value at an existing path with the JSON in `text`. */
export async function setJson(
  session: RedisSession,
  key: Uint8Array,
  path: string,
  text: string,
): Promise<void> {
  assertPath(path);
  let line: string;
  try {
    line = formatJsonLine(parseJson(text));
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      throw new DbError('syntax', msg('Not valid JSON: {0}', error.message), {
        position: error.offset,
      });
    }
    throw error;
  }
  // XX: only where a value is — a path that vanished must not be created by mistake.
  const reply = await session.call(['JSON.SET', key, path, line, 'XX']);
  if (reply === null) {
    throw new DbError('not-found', msg('The path no longer exists: refresh the key'));
  }
}

/** Removes the value at a path below the root (the root goes with the key). */
export async function deleteJson(
  session: RedisSession,
  key: Uint8Array,
  path: string,
): Promise<void> {
  assertPath(path);
  if (path === JSON_ROOT) {
    throw new DbError('unsupported', msg('The whole document goes with the key: delete the key'));
  }
  const removed = replyNumber(await session.call(['JSON.DEL', key, path]));
  if (removed === undefined || removed < 1) {
    throw new DbError('not-found', msg('The path no longer exists: refresh the key'));
  }
}

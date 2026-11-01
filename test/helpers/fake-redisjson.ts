// A RedisJSON key for unit tests (V13.14): a document in memory that answers the JSON.*
// commands the key page uses, for the paths it builds (`$`, `["name"]`, `[3]`). Numbers
// are kept as text, as the server stores them.

import { DbError } from '../../src/core/errors';
import { type JsonValue, parseJson } from '../../src/core/json/json-tree';
import type { RedisReply } from '../../src/drivers/redis-driver';
import { bulk, FakeRedisSession } from './fake-redis';

type Doc =
  | { readonly t: 'object'; readonly members: [string, Doc][] }
  | { readonly t: 'array'; readonly items: Doc[] }
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'number'; readonly text: string }
  | { readonly t: 'boolean'; readonly v: boolean }
  | { readonly t: 'null' };

function fromJs(value: unknown): Doc {
  if (value === null) {
    return { t: 'null' };
  }
  if (Array.isArray(value)) {
    return { t: 'array', items: value.map(fromJs) };
  }
  if (typeof value === 'string') {
    return { t: 'string', v: value };
  }
  if (typeof value === 'number') {
    return { t: 'number', text: String(value) };
  }
  if (typeof value === 'boolean') {
    return { t: 'boolean', v: value };
  }
  return {
    t: 'object',
    members: Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fromJs(v)]),
  };
}

/** A document read without loss: numbers stay the text written. */
function fromTree(value: JsonValue): Doc {
  switch (value.type) {
    case 'object':
      return { t: 'object', members: value.members.map(([k, v]) => [k, fromTree(v)]) };
    case 'array':
      return { t: 'array', items: value.items.map(fromTree) };
    case 'string':
      return { t: 'string', v: value.value };
    case 'number':
      return { t: 'number', text: value.text };
    case 'bool':
      return { t: 'boolean', v: value.value };
    case 'null':
      return { t: 'null' };
  }
}

function toText(doc: Doc): string {
  switch (doc.t) {
    case 'object':
      return `{${doc.members.map(([k, v]) => `${JSON.stringify(k)}:${toText(v)}`).join(',')}}`;
    case 'array':
      return `[${doc.items.map(toText).join(',')}]`;
    case 'string':
      return JSON.stringify(doc.v);
    case 'number':
      return doc.text;
    case 'boolean':
      return String(doc.v);
    case 'null':
      return 'null';
  }
}

/** `$["a\"b"][2]` as steps; undefined for a path this emulator does not know. */
function steps(path: string): (string | number)[] | undefined {
  if (!path.startsWith('$')) {
    return undefined;
  }
  const result: (string | number)[] = [];
  let at = 1;
  while (at < path.length) {
    const quoted = /^\["((?:[^"\\]|\\.)*)"\]/.exec(path.slice(at));
    if (quoted) {
      result.push((quoted[1] ?? '').replace(/\\(.)/g, '$1'));
      at += quoted[0].length;
      continue;
    }
    const index = /^\[(\d+)\]/.exec(path.slice(at));
    if (!index) {
      return undefined;
    }
    result.push(Number(index[1]));
    at += index[0].length;
  }
  return result;
}

function find(root: Doc, path: string): Doc | undefined {
  const walk = steps(path);
  let at: Doc | undefined = root;
  for (const step of walk ?? []) {
    if (at === undefined) {
      return undefined;
    }
    at =
      typeof step === 'string'
        ? at.t === 'object'
          ? at.members.find(([name]) => name === step)?.[1]
          : undefined
        : at.t === 'array'
          ? at.items[step]
          : undefined;
  }
  return walk === undefined ? undefined : at;
}

function kindOf(doc: Doc): string {
  if (doc.t === 'number') {
    return /^-?\d+$/.test(doc.text) ? 'integer' : 'number';
  }
  return doc.t;
}

export interface FakeJsonOptions {
  /** Answers every JSON.* with this error, as a server without the module does. */
  readonly noModule?: boolean;
  /** Bytes JSON.DEBUG MEMORY reports. */
  readonly memory?: number;
  /** JSON.DEBUG is unknown. */
  readonly noDebug?: boolean;
}

/** A session with one JSON key; `calls` shows what was asked. */
export class FakeJsonSession extends FakeRedisSession {
  private root: Doc;

  constructor(
    value: unknown,
    private readonly options: FakeJsonOptions = {},
    private readonly key = 'doc',
  ) {
    super((words) => this.answerJson(words));
    this.root = fromJs(value);
  }

  /** The document as compact JSON text. */
  text(): string {
    return toText(this.root);
  }

  private answerJson(words: string[]): RedisReply | Error | undefined {
    // JSON.DEBUG MEMORY key path: the subcommand comes before the key.
    const args = words[0] === 'JSON.DEBUG' ? [words[0], ...words.slice(2)] : words;
    const [command = '', key = '', path = '$', ...rest] = args;
    if (!command.startsWith('JSON.')) {
      // What the key page asks of any key before it knows the type.
      switch (command) {
        case 'TYPE':
          return key === this.key ? bulk('ReJSON-RL') : bulk('none');
        case 'PTTL':
          return key === this.key ? '-1' : '-2';
        case 'MEMORY':
        case 'OBJECT':
          return null;
        default:
          return bulk('OK');
      }
    }
    if (this.options.noModule) {
      return new DbError('unsupported', `ERR unknown command '${command}'`);
    }
    if (key !== this.key) {
      return command === 'JSON.GET' || command === 'JSON.SET' ? null : [];
    }
    const hit = find(this.root, path);
    switch (command) {
      case 'JSON.TYPE':
        return hit === undefined ? [] : [bulk(kindOf(hit))];
      case 'JSON.OBJKEYS':
        return hit?.t === 'object' ? [hit.members.map(([name]) => bulk(name))] : [null];
      case 'JSON.OBJLEN':
        return [hit?.t === 'object' ? String(hit.members.length) : null];
      case 'JSON.ARRLEN':
        return [hit?.t === 'array' ? String(hit.items.length) : null];
      case 'JSON.STRLEN':
        return [hit?.t === 'string' ? String(hit.v.length) : null];
      case 'JSON.GET':
        return hit === undefined ? null : bulk(`[${toText(hit)}]`);
      case 'JSON.DEBUG':
        if (this.options.noDebug) {
          return new DbError('unsupported', 'ERR unknown subcommand');
        }
        return hit === undefined ? [] : [String(this.options.memory ?? toText(hit).length)];
      case 'JSON.SET': {
        if (hit === undefined) {
          return null;
        }
        const next = fromTree(parseJson(rest[0] ?? 'null'));
        this.replace(path, next);
        return bulk('OK');
      }
      case 'JSON.DEL':
        return hit === undefined || path === '$' ? '0' : (this.remove(path), '1');
      default:
        return new DbError('unsupported', `ERR unknown command '${command}'`);
    }
  }

  private replace(path: string, next: Doc): void {
    const walk = steps(path) ?? [];
    if (walk.length === 0) {
      this.root = next;
      return;
    }
    const parent = find(this.root, `$${pathOf(walk.slice(0, -1))}`);
    const last = walk[walk.length - 1];
    if (parent?.t === 'object') {
      const member = parent.members.find(([name]) => name === last);
      if (member) {
        member[1] = next;
      }
    } else if (parent?.t === 'array' && typeof last === 'number') {
      parent.items[last] = next;
    }
  }

  private remove(path: string): void {
    const walk = steps(path) ?? [];
    const parent = find(this.root, `$${pathOf(walk.slice(0, -1))}`);
    const last = walk[walk.length - 1];
    if (parent?.t === 'object') {
      parent.members.splice(
        parent.members.findIndex(([name]) => name === last),
        1,
      );
    } else if (parent?.t === 'array' && typeof last === 'number') {
      parent.items.splice(last, 1);
    }
  }
}

function pathOf(walk: readonly (string | number)[]): string {
  return walk
    .map((step) =>
      typeof step === 'number'
        ? `[${String(step)}]`
        : `["${step.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`,
    )
    .join('');
}

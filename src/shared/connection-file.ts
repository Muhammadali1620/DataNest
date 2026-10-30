// A file of connections that people share: `.vscode/datanest.json` of a project
// (V4.7) and an exported connection list (V4.11). It never holds a password or any
// other secret — those stay in each user's SecretStorage (ARCHITECTURE.md §8).

import {
  CONNECTION_LIMITS,
  type ConnectionInput,
  connectionProblems,
  HOP_ID_PATTERN,
  type SshHop,
  type SshTunnelConfig,
} from './connection';
import { connectionInputShape, sshHopShape } from './connection-schema';
import { parseJsonc } from './jsonc';
import { array, isPlainObject, object, optional, SchemaError, string } from './schema';
import { msg } from '../core/user-message';

export const CONNECTION_FILE_VERSION = 1;

/** Most connections one file may list; more is not a hand-kept file. */
export const MAX_FILE_CONNECTIONS = 10_000;

/**
 * Ids in a file are short names chosen by people (`staging`); a connection's secrets
 * on each computer are found by it, so it should not change when the name does.
 */
export const LOCAL_ID_PATTERN = HOP_ID_PATTERN;

const idSchema = string({ minLength: 1, maxLength: CONNECTION_LIMITS.hopId });

// Hop ids may be left out by hand; they are filled in by position.
const fileHopShape = { ...sshHopShape, id: optional(idSchema) };

const entrySchema = object({
  ...connectionInputShape,
  id: optional(idSchema),
  ssh: optional(
    object({ ...fileHopShape, jumps: optional(array(object(fileHopShape), { maxLength: 20 })) }),
  ),
});

/** One connection of a file, as a connection input plus its id in the file, if any. */
export interface FileEntry {
  readonly id?: string;
  readonly input: ConnectionInput;
}

/** Each listed connection either reads or says why it was skipped. */
export type EntryResult =
  | { readonly ok: true; readonly entry: FileEntry }
  | { readonly ok: false; readonly problem: string };

export interface ConnectionFile {
  /** The object as read, so keys this version does not know survive a rewrite. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** One per item of `connections`, in order. */
  readonly entries: readonly EntryResult[];
  /** Folder names in the order they were kept (exports only). */
  readonly folders: readonly string[];
}

export type FileReadResult =
  | { readonly ok: true; readonly file: ConnectionFile }
  | { readonly ok: false; readonly error: string };

/**
 * Reads a connection file. A broken entry does not spoil the others: it is reported
 * and left out, and its JSON is kept in `raw` so a rewrite does not lose it.
 */
export function readConnectionFile(text: string): FileReadResult {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: msg('The file must hold a JSON object with a "connections" list') };
  }
  const list: unknown = value.connections ?? [];
  if (!Array.isArray(list)) {
    return { ok: false, error: '"connections" must be a list' };
  }
  if (list.length > MAX_FILE_CONNECTIONS) {
    return {
      ok: false,
      error: msg('The file lists more than {0} connections', MAX_FILE_CONNECTIONS),
    };
  }
  const folders: unknown = value.folders;
  return {
    ok: true,
    file: {
      raw: value,
      entries: list.map((item: unknown) => readEntry(item)),
      folders: Array.isArray(folders)
        ? folders.filter(
            (folder): folder is string =>
              typeof folder === 'string' &&
              folder.trim() !== '' &&
              folder.length <= CONNECTION_LIMITS.folder,
          )
        : [],
    },
  };
}

function readEntry(value: unknown): EntryResult {
  try {
    const { id, ssh, ...rest } = entrySchema.parse(value);
    if (id !== undefined && !LOCAL_ID_PATTERN.test(id)) {
      return { ok: false, problem: 'id: use only letters, digits, "-" and "_"' };
    }
    const input: ConnectionInput = {
      ...rest,
      ...(ssh === undefined ? {} : { ssh: withHopIds(ssh) }),
    };
    const problems = connectionProblems(input);
    if (problems.length > 0) {
      return { ok: false, problem: problems.join(', ') };
    }
    return { ok: true, entry: { ...(id === undefined ? {} : { id }), input } };
  } catch (error) {
    if (error instanceof SchemaError) {
      return { ok: false, problem: error.message };
    }
    throw error;
  }
}

type LooseHop = Omit<SshHop, 'id'> & { readonly id?: string };

/** Hops without an id get one by position: `ssh` for the server, `jump-1`… for the jumps. */
function withHopIds(ssh: LooseHop & { readonly jumps?: readonly LooseHop[] }): SshTunnelConfig {
  const { jumps, ...server } = ssh;
  return {
    ...server,
    id: server.id ?? 'ssh',
    ...(jumps === undefined
      ? {}
      : { jumps: jumps.map((jump, index) => ({ ...jump, id: jump.id ?? `jump-${index + 1}` })) }),
  };
}

/** The JSON of one connection as a file keeps it: its id first, no empty fields. */
export function entryJson(entry: FileEntry): Record<string, unknown> {
  const fields: [string, unknown][] = Object.entries(entry.input);
  return {
    ...(entry.id === undefined ? {} : { id: entry.id }),
    ...Object.fromEntries(fields.filter(([, value]) => value !== undefined)),
  };
}

export interface FileContents {
  /** What the file held before; its other keys are written back unchanged. */
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly connections: readonly unknown[];
  /** Absent keeps the folders `raw` had. */
  readonly folders?: readonly string[];
}

/** The text of a connection file: `$schema` and `version` first, two-space indents. */
export function writeConnectionFile(contents: FileContents): string {
  const {
    $schema,
    version: _version,
    folders: oldFolders,
    connections: _connections,
    ...rest
  } = contents.raw ?? {};
  const folders = contents.folders ?? oldFolders;
  const hasFolders = Array.isArray(folders) && folders.length > 0;
  const out = {
    ...($schema === undefined ? {} : { $schema }),
    version: CONNECTION_FILE_VERSION,
    ...rest,
    ...(hasFolders ? { folders } : {}),
    connections: contents.connections,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * A file id made from a name: `Staging EU` → `staging-eu`, unique among `taken`.
 * Names without Latin letters or digits become `connection`.
 */
export function localIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48)
      .replace(/-+$/u, '') || 'connection';
  if (!taken.has(slug)) {
    return slug;
  }
  for (let attempt = 2; ; attempt++) {
    const candidate = `${slug}-${attempt}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

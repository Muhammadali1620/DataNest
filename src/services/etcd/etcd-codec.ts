// How etcd's JSON gateway writes things (V13.19), and how DataNest writes them back:
// bytes are base64, 64-bit numbers are decimal strings, and a field that holds its zero
// value (an empty value, version 0, no lease) is left out of the answer altogether. Free
// of everything else, so the rules are tested alone.

/** Bytes of a base64 text; an absent field is empty. */
export function fromBase64(text: unknown): Uint8Array {
  return typeof text === 'string' ? new Uint8Array(Buffer.from(text, 'base64')) : new Uint8Array();
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * The first key after every key that starts with `prefix` (etcd's `range_end` of a
 * prefix): the prefix with its last byte raised by one, after dropping trailing 0xFF
 * bytes. A prefix of nothing but 0xFF bytes, or an empty one, reaches the end of the key
 * space, which etcd writes as a single zero byte.
 */
export function prefixEnd(prefix: Uint8Array): Uint8Array {
  const end = Uint8Array.from(prefix);
  for (let index = end.length - 1; index >= 0; index -= 1) {
    if ((end[index] ?? 0) < 0xff) {
      end[index] = (end[index] ?? 0) + 1;
      return end.subarray(0, index + 1);
    }
  }
  return new Uint8Array([0]);
}

/** The smallest key greater than `key`: the key followed by a zero byte. */
export function afterKey(key: Uint8Array): Uint8Array {
  const next = new Uint8Array(key.length + 1);
  next.set(key);
  return next;
}

export function startsWith(key: Uint8Array, prefix: Uint8Array): boolean {
  return key.length >= prefix.length && prefix.every((byte, index) => key[index] === byte);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A decimal string of the gateway as a number; absent or odd text is 0. */
export function count(text: unknown): number {
  if (typeof text === 'number') {
    return Number.isFinite(text) ? text : 0;
  }
  if (typeof text !== 'string') {
    return 0;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

/** A decimal string of the gateway kept as text, so a 64-bit id loses nothing; absent is "0". */
export function int64(text: unknown): string {
  if (typeof text === 'string' && /^-?\d+$/u.test(text)) {
    return text;
  }
  return typeof text === 'number' && Number.isInteger(text) ? String(text) : '0';
}

/** One key of the store, as the gateway reports it. */
export interface EtcdEntry {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
  /** The revision that created the key's current life; 0 when it was never there. */
  readonly createRevision: string;
  /** The revision of the last change: what a compare-and-swap checks. */
  readonly modRevision: string;
  /** Changes since the key was created (1 after the first put). */
  readonly version: number;
  /** The lease that deletes the key when it ends, as a decimal id; `0` for none. */
  readonly lease: string;
}

interface WireEntry {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly create_revision?: unknown;
  readonly mod_revision?: unknown;
  readonly version?: unknown;
  readonly lease?: unknown;
}

export function entryOf(wire: unknown): EtcdEntry {
  const kv = (typeof wire === 'object' && wire !== null ? wire : {}) as WireEntry;
  return {
    key: fromBase64(kv.key),
    value: fromBase64(kv.value),
    createRevision: int64(kv.create_revision),
    modRevision: int64(kv.mod_revision),
    version: count(kv.version),
    lease: int64(kv.lease),
  };
}

// Redis values are bytes (V7.3). The page shows UTF-8 text as it is — line breaks and
// all — and anything else as hex, which is also how such a value is edited; a value
// too big to show whole travels cut, marked, and is not editable.

import { displayKey } from './redis-key';

export interface RedisValue {
  /** UTF-8 text, or redis-cli style `\xHH` text for bytes that are not UTF-8. */
  readonly text: string;
  /** The bytes in hex when they are not UTF-8; edit these, not `text`. */
  readonly hex?: string;
  /** Only the start of the value is here; the page must not write it back. */
  readonly truncated?: boolean;
  /** The size of the whole value in bytes, when cut. */
  readonly size?: number;
}

const STRICT = new TextDecoder('utf-8', { fatal: true });
const ENCODER = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Bytes from hex; spaces and line breaks between pairs are allowed. */
export function hexBytes(hex: string): Uint8Array | undefined {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    return undefined;
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * A value for the page. `limit` caps the bytes sent; a longer value is cut there (at a
 * character boundary for text) and marked. `size` is the full size, when known apart.
 */
export function redisValueOf(bytes: Uint8Array, limit = Infinity, size = bytes.length): RedisValue {
  const cut = bytes.length > limit || size > bytes.length;
  const kept = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  let text: string | undefined;
  try {
    text = STRICT.decode(kept);
  } catch {
    // A cut may split the last character: try once without its broken tail.
    if (cut) {
      for (let back = 1; back <= 3 && text === undefined; back++) {
        try {
          text = STRICT.decode(kept.subarray(0, kept.length - back));
        } catch {
          text = undefined;
        }
      }
    }
  }
  const marks = cut ? { truncated: true, size: Math.max(size, bytes.length) } : {};
  return text === undefined
    ? { text: displayKey(kept), hex: toHex(kept), ...marks }
    : { text, ...marks };
}

/** The bytes to write; undefined for a cut value or hex that does not parse. */
export function redisValueBytes(value: RedisValue): Uint8Array | undefined {
  if (value.truncated === true) {
    return undefined;
  }
  return value.hex === undefined ? ENCODER.encode(value.text) : hexBytes(value.hex);
}

/** The same value, as the page last saw it: compares bytes, not how they are shown. */
export function sameValue(a: RedisValue, b: RedisValue): boolean {
  return (a.hex ?? `t:${a.text}`) === (b.hex ?? `t:${b.text}`);
}

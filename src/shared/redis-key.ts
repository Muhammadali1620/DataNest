// Redis keys are bytes (V7.2). The tree, the value editor and messages show them as
// text: UTF-8 as it is, anything else — and control characters — as `\xHH`, the way
// redis-cli prints them. A key that is not exactly its text keeps its bytes in hex,
// so it is found again byte for byte.

export interface RedisKeyRef {
  /** What the user sees. */
  readonly text: string;
  /** The exact bytes, only when `text` does not encode back to them. */
  readonly hex?: string;
}

const ENCODER = new TextEncoder();

function hexByte(byte: number): string {
  return `\\x${byte.toString(16).padStart(2, '0')}`;
}

/** The length of the UTF-8 sequence that starts at `index`, or 0 when it is broken. */
function sequenceLength(bytes: Uint8Array, index: number): number {
  const lead = bytes[index] ?? 0;
  const [length, min] =
    lead < 0x80
      ? [1, 0]
      : lead >= 0xc2 && lead < 0xe0
        ? [2, 0x80]
        : lead >= 0xe0 && lead < 0xf0
          ? [3, 0x800]
          : lead >= 0xf0 && lead < 0xf5
            ? [4, 0x10000]
            : [0, 0];
  if (length <= 1 || index + length > bytes.length) {
    return length === 1 ? 1 : 0;
  }
  let code = lead & (0xff >> (length + 1));
  for (let offset = 1; offset < length; offset++) {
    const next = bytes[index + offset] ?? 0;
    if ((next & 0xc0) !== 0x80) {
      return 0;
    }
    code = (code << 6) | (next & 0x3f);
  }
  // Overlong forms, surrogates and code points past Unicode are not UTF-8.
  return code < min || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? 0 : length;
}

/** A key as text: UTF-8 kept, broken bytes and control characters as `\xHH`. */
export function displayKey(bytes: Uint8Array): string {
  let text = '';
  let index = 0;
  const decoder = new TextDecoder('utf-8');
  while (index < bytes.length) {
    const length = sequenceLength(bytes, index);
    if (length === 0) {
      text += hexByte(bytes[index] ?? 0);
      index += 1;
      continue;
    }
    const byte = bytes[index] ?? 0;
    if (length === 1 && (byte < 0x20 || byte === 0x7f)) {
      text += hexByte(byte);
    } else {
      text += decoder.decode(bytes.subarray(index, index + length));
    }
    index += length;
  }
  return text;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function redisKeyRef(bytes: Uint8Array): RedisKeyRef {
  const text = displayKey(bytes);
  return sameBytes(ENCODER.encode(text), bytes) ? { text } : { text, hex: toHex(bytes) };
}

/** The key as the server knows it. */
export function redisKeyBytes(key: RedisKeyRef): Uint8Array {
  return key.hex === undefined ? ENCODER.encode(key.text) : fromHex(key.hex);
}

/** One string per key, for maps and node ids: the bytes in hex, or the text. */
export function redisKeyId(key: RedisKeyRef): string {
  return key.hex === undefined ? `t:${key.text}` : `x:${key.hex}`;
}

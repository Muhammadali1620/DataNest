// Binary values for the value panel: hex dump, image detection, sizes.

export const HEX_ROW_BYTES = 16;

export interface HexRow {
  /** Offset of the row's first byte, eight hex digits. */
  readonly offset: string;
  /** The bytes as hex pairs, padded so every row has the same width. */
  readonly hex: string;
  /** The bytes as text, with a dot for anything unprintable. */
  readonly ascii: string;
}

/** Hex dump rows for `count` bytes starting at `from`. */
export function hexRows(bytes: Uint8Array, from: number, count: number): HexRow[] {
  const end = Math.min(bytes.length, from + count);
  const rows: HexRow[] = [];
  for (let start = from; start < end; start += HEX_ROW_BYTES) {
    const slice = bytes.subarray(start, Math.min(end, start + HEX_ROW_BYTES));
    const pairs = Array.from(slice, (byte) => byte.toString(16).padStart(2, '0'));
    rows.push({
      offset: start.toString(16).padStart(8, '0'),
      hex: pairs.join(' ').padEnd(HEX_ROW_BYTES * 3 - 1, ' '),
      ascii: Array.from(slice, (byte) =>
        byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.',
      ).join(''),
    });
  }
  return rows;
}

/** Bytes of a hex string such as `89504e47`; a dangling digit is ignored. */
export function bytesFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((byte, index) => bytes[at + index] === byte);
}

/**
 * The MIME type of a picture the webview can draw, judged by the first bytes, or
 * undefined. Names and column types say nothing about what a BLOB really holds.
 * SVG is left out on purpose: it is text and can carry scripts.
 */
export function imageMimeOf(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return bytes[5] === 0x61 ? 'image/gif' : undefined;
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length >= 26) {
    // "BM" alone is two ordinary letters; the DIB header size makes it a bitmap.
    const header = (bytes[14] ?? 0) | ((bytes[15] ?? 0) << 8);
    return [12, 40, 52, 56, 64, 108, 124].includes(header) && bytes[16] !== undefined
      ? 'image/bmp'
      : undefined;
  }
  return undefined;
}

/** `1.5 KB`-style size; bytes below 1 KB are shown exactly. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

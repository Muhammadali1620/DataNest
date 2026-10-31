// What the page and the host agree on about TinyPNG (the optional "compress with TinyPNG"):
// the formats it takes, how big a file may be, what a key looks like and the ways it can fail.

export const TINY_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type TinyMime = (typeof TINY_MIMES)[number];

/** TinyPNG refuses more than 5 MB; the page does not even send such a file. */
export const MAX_TINY_BYTES = 5 * 1024 * 1024;
export const MAX_TINY_BASE64 = Math.ceil((MAX_TINY_BYTES * 4) / 3) + 8;

export const TINY_ERRORS = [
  'no-key',
  'unauthorized',
  'limit',
  'unsupported',
  'too-big',
  'network',
  'failed',
] as const;
export type TinyError = (typeof TINY_ERRORS)[number];

/** An API key is a run of letters, digits, `-` and `_`. */
export function isTinyKey(text: string): boolean {
  return /^[A-Za-z0-9_-]{8,200}$/u.test(text);
}

export function isTinyMime(text: string): text is TinyMime {
  return (TINY_MIMES as readonly string[]).includes(text);
}

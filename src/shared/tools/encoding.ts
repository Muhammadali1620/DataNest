// Text encoders of the Tools page. Pure: the page and the tests use them as they are.
// Each decoder answers undefined for text that is not valid in its format, so the page
// can say so instead of showing garbage.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type EncodingKind = 'base64' | 'url' | 'unicode';
export const ENCODING_KINDS: readonly EncodingKind[] = ['base64', 'url', 'unicode'];

/** UTF-8 bytes to Base64, in chunks so a large text does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array | undefined {
  // Whitespace and line breaks are common in pasted Base64; URL-safe letters and a missing
  // padding are accepted too.
  let clean = text.replace(/\s+/gu, '').replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(clean)) {
    return undefined;
  }
  clean = clean.replace(/=+$/u, '');
  if (clean.length % 4 === 1) {
    return undefined;
  }
  clean += '='.repeat((4 - (clean.length % 4)) % 4);
  try {
    const binary = atob(clean);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function base64Encode(text: string): string {
  return bytesToBase64(encoder.encode(text));
}

export function base64Decode(text: string): string | undefined {
  const bytes = base64ToBytes(text);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function urlEncode(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    // A lone surrogate cannot be encoded; replace it as UTF-8 would.
    return encodeURIComponent(
      text.replace(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu,
        '\ufffd',
      ),
    );
  }
}

export function urlDecode(text: string): string | undefined {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '));
  } catch {
    return undefined;
  }
}

/** `é` → `é`; everything outside printable ASCII is escaped, code unit by code unit. */
export function unicodeEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out +=
      code >= 0x20 && code < 0x7f ? text.charAt(i) : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/** `é`, `\u{1F600}` and `\x41` back to characters; other text is kept as it is. */
export function unicodeUnescape(text: string): string | undefined {
  const state = { bad: false };
  const out = text.replace(
    /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\u/gu,
    (match, braced: string | undefined, plain: string | undefined, hex: string | undefined) => {
      const digits = braced ?? plain ?? hex;
      if (digits === undefined) {
        state.bad = true;
        return match;
      }
      const code = Number.parseInt(digits, 16);
      if (code > 0x10ffff) {
        state.bad = true;
        return match;
      }
      return String.fromCodePoint(code);
    },
  );
  return state.bad ? undefined : out;
}

export function encode(kind: EncodingKind, text: string): string {
  switch (kind) {
    case 'base64':
      return base64Encode(text);
    case 'url':
      return urlEncode(text);
    case 'unicode':
      return unicodeEscape(text);
  }
}

export function decode(kind: EncodingKind, text: string): string | undefined {
  switch (kind) {
    case 'base64':
      return base64Decode(text);
    case 'url':
      return urlDecode(text);
    case 'unicode':
      return unicodeUnescape(text);
  }
}

import { describe, expect, it } from 'vitest';
import {
  base64Decode,
  base64Encode,
  decode,
  encode,
  unicodeEscape,
  unicodeUnescape,
  urlDecode,
  urlEncode,
} from '../../../../src/shared/tools/encoding';

describe('base64', () => {
  it('encodes and decodes ASCII and UTF-8 text', () => {
    expect(base64Encode('hello')).toBe('aGVsbG8=');
    expect(base64Decode('aGVsbG8=')).toBe('hello');
    const text = 'Привет, мир — 日本語 😀';
    expect(base64Decode(base64Encode(text))).toBe(text);
  });

  it('handles the empty text and a large one', () => {
    expect(base64Encode('')).toBe('');
    expect(base64Decode('')).toBe('');
    const big = 'x'.repeat(200_000);
    expect(base64Decode(base64Encode(big))).toBe(big);
  });

  it('accepts line breaks, a missing padding and URL-safe letters', () => {
    expect(base64Decode('aGVs\nbG8')).toBe('hello');
    expect(base64Decode(' aGVsbG8= ')).toBe('hello');
    expect(base64Decode('-_-_')).toBe(base64Decode('+/+/'));
  });

  it('refuses text that is not Base64 or not UTF-8', () => {
    expect(base64Decode('not base64!')).toBeUndefined();
    expect(base64Decode('a')).toBeUndefined();
    expect(base64Decode('/w==')).toBeUndefined();
  });
});

describe('url', () => {
  it('encodes and decodes', () => {
    expect(urlEncode('a b&c=д')).toBe('a%20b%26c%3D%D0%B4');
    expect(urlDecode('a%20b%26c%3D%D0%B4')).toBe('a b&c=д');
  });

  it('reads + as a space when decoding, like a query string', () => {
    expect(urlDecode('a+b')).toBe('a b');
  });

  it('encodes a lone surrogate without throwing, and refuses a broken escape', () => {
    expect(urlEncode('\ud800')).toBe('%EF%BF%BD');
    expect(urlDecode('%E0%A4%A')).toBeUndefined();
    expect(urlDecode('%')).toBeUndefined();
  });
});

describe('unicode escapes', () => {
  it('escapes everything outside printable ASCII', () => {
    expect(unicodeEscape('aé\n')).toBe('a\\u00e9\\u000a');
    expect(unicodeEscape('😀')).toBe('\\ud83d\\ude00');
    expect(unicodeEscape('plain')).toBe('plain');
  });

  it('turns \\u, \\u{} and \\x escapes back', () => {
    expect(unicodeUnescape('a\\u00e9')).toBe('aé');
    expect(unicodeUnescape('\\ud83d\\ude00')).toBe('😀');
    expect(unicodeUnescape('\\u{1F600}')).toBe('😀');
    expect(unicodeUnescape('\\x41')).toBe('A');
    expect(unicodeUnescape('no escapes')).toBe('no escapes');
  });

  it('round-trips', () => {
    const text = 'ñ — Ж 😀\t';
    expect(unicodeUnescape(unicodeEscape(text))).toBe(text);
  });

  it('refuses a broken or out-of-range escape', () => {
    expect(unicodeUnescape('\\u12')).toBeUndefined();
    expect(unicodeUnescape('\\u{110000}')).toBeUndefined();
  });
});

describe('encode / decode by kind', () => {
  it.each(['base64', 'url', 'unicode'] as const)('round-trips %s', (kind) => {
    const text = 'Тест: a/b?c=1 é';
    expect(decode(kind, encode(kind, text))).toBe(text);
  });
});

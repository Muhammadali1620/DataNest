// A Redis reply as text, the way redis-cli prints it (V7.4): strings in quotes with
// escapes, `(integer) 5`, `(nil)`, `(error) …`, and numbered, indented arrays. Big
// replies stop after a number of lines, saying how many items were left out.

import type { RedisReply } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';

const STRICT = new TextDecoder('utf-8', { fatal: true });

/** `"text"` with `\n`, `\"`, `\\` and `\xHH` for bytes that are neither text nor printable. */
export function quoteBulk(bytes: Uint8Array): string {
  let text: string;
  try {
    text = STRICT.decode(bytes);
  } catch {
    return `"${Array.from(bytes, (byte) => (byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`)).join('')}"`;
  }
  let out = '';
  for (const char of text) {
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : char;
      }
    }
  }
  return `"${out}"`;
}

export interface FormatOptions {
  /** Items shown per array; the rest is counted. */
  readonly maxItems: number;
}

/** The lines of a reply. */
export function formatReply(reply: RedisReply, options: FormatOptions): string[] {
  if (reply === null) {
    return ['(nil)'];
  }
  if (typeof reply === 'string') {
    return [`(integer) ${reply}`];
  }
  if (reply instanceof Uint8Array) {
    return [quoteBulk(reply)];
  }
  if (isErrorReply(reply)) {
    return [`(error) ${reply.error}`];
  }
  if (reply.length === 0) {
    return ['(empty array)'];
  }
  const shown = reply.slice(0, options.maxItems);
  const width = String(shown.length).length;
  const lines: string[] = [];
  shown.forEach((item: RedisReply, index: number) => {
    const label = `${String(index + 1).padStart(width)}) `;
    const inner = formatReply(item, options);
    inner.forEach((line, offset) => {
      lines.push(offset === 0 ? `${label}${line}` : `${' '.repeat(label.length)}${line}`);
    });
  });
  if (reply.length > shown.length) {
    lines.push(`(${reply.length - shown.length} more)`);
  }
  return lines;
}

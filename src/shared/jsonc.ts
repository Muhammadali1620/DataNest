import { msg } from '../core/user-message';
// JSON with comments and trailing commas, the way VS Code reads its own files in
// `.vscode/`. People hand-edit those, so a comment must not make a file unreadable.

/** Thrown for text that is not JSON even after comments are removed. */
export class JsoncError extends Error {
  override readonly name = 'JsoncError';
}

/**
 * Parses JSONC: `//` and `/* *\/` comments and commas before `}` or `]` are ignored
 * outside strings, a leading byte order mark too. Everything else is plain JSON.
 */
export function parseJsonc(text: string): unknown {
  const plain = stripJsonc(text.startsWith('﻿') ? text.slice(1) : text);
  try {
    return JSON.parse(plain) as unknown;
  } catch (error) {
    throw new JsoncError(error instanceof Error ? error.message : String(error));
  }
}

/** The text with comments blanked and trailing commas dropped; strings are untouched. */
export function stripJsonc(text: string): string {
  let out = '';
  let index = 0;
  // Where the last comma outside strings was written, until something other than
  // whitespace or a comment follows it.
  let pendingComma = -1;
  // The last character outside whitespace and comments: a comma right after `[`, `{`
  // or another comma follows no value, so it is an error, not a trailing comma.
  let previous = '';
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1];
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      pendingComma = -1;
      previous = '"';
    } else if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) {
        throw new JsoncError(msg('A block comment is not closed'));
      }
      // Kept as a space, so the comment still separates the tokens around it.
      out += ' ';
      index = end + 2;
    } else if ((char === '}' || char === ']') && pendingComma !== -1) {
      out = out.slice(0, pendingComma) + out.slice(pendingComma + 1) + char;
      pendingComma = -1;
      previous = char;
      index++;
    } else {
      if (!/\s/u.test(char)) {
        pendingComma = char === ',' && !'[{,'.includes(previous) ? out.length : -1;
        previous = char;
      }
      out += char;
      index++;
    }
  }
  return out;
}

/** The index just past the string that starts at `start`; an open string runs to the end. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else {
      index++;
    }
  }
  return text.length;
}

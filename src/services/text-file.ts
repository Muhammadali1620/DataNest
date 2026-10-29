// Reading a text file in parts, for files too large to hold as one string (V5.1).
// The encoding comes from the byte order mark; without one the file is UTF-8.

import { createReadStream } from 'node:fs';
import { TextDecoder } from 'node:util';
import type { ScriptChunk } from './script-runner';

/** Bytes read at a time. */
export const CHUNK_BYTES = 256 * 1024;

/** The encoding a byte order mark announces; UTF-8 when there is none. */
export function encodingOf(head: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' {
  if (head[0] === 0xff && head[1] === 0xfe) {
    return 'utf-16le';
  }
  if (head[0] === 0xfe && head[1] === 0xff) {
    return 'utf-16be';
  }
  return 'utf-8';
}

/**
 * The file's text in parts, each with the number of bytes it came from. A character
 * cut between two reads is joined again; the byte order mark is dropped.
 */
export async function* readTextChunks(
  path: string,
  chunkBytes: number = CHUNK_BYTES,
): AsyncGenerator<ScriptChunk> {
  let decoder: TextDecoder | undefined;
  for await (const raw of createReadStream(path, { highWaterMark: chunkBytes })) {
    const bytes = raw as Buffer;
    decoder ??= new TextDecoder(encodingOf(bytes));
    yield { text: decoder.decode(bytes, { stream: true }), bytes: bytes.length };
  }
  const rest = decoder?.decode() ?? '';
  if (rest !== '') {
    yield { text: rest, bytes: 0 };
  }
}

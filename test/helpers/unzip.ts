// A small ZIP reader for tests, independent of the writer under test: it follows the
// central directory, inflates, and checks every CRC and size the archive claims.

import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/services/zip';

export interface UnzippedEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly data: Buffer;
}

export function unzip(archive: Uint8Array): UnzippedEntry[] {
  const buffer = Buffer.from(archive);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) {
    throw new Error('no end-of-central-directory record');
  }
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  const entries: UnzippedEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) {
      throw new Error('bad central directory header');
    }
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressed = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const offset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      throw new Error(`bad local header for ${name}`);
    }
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const body = buffer.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    if (data.length !== size) {
      throw new Error(`size mismatch for ${name}`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`crc mismatch for ${name}`);
    }
    entries.push({ name, method, flags, data });
  }
  return entries;
}

/** One entry's text, or a failure that names what is missing. */
export function entryText(entries: readonly UnzippedEntry[], name: string): string {
  const found = entries.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`no entry ${name}; have ${entries.map((entry) => entry.name).join(', ')}`);
  }
  return found.data.toString('utf8');
}

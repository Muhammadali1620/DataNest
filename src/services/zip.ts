// A ZIP writer, just enough for an .xlsx: whole files, deflated, no encryption, no
// ZIP64. Written here because the formats are tiny and a dependency would carry far
// more than this needs (ARCHITECTURE.md §2, no native modules).

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, with `/` separators. */
  readonly name: string;
  readonly data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what ZIP stores; the clock is only a label here. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Largest archive and entry this writer can describe without ZIP64. */
export const MAX_ZIP_BYTES = 0xfffffffe;
export const MAX_ZIP_ENTRIES = 0xfffe;

export function zip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('Too many files for a ZIP archive');
  }
  const stamp = dosDateTime(now);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data);
    // Storing is better for data that does not shrink, e.g. one that is already packed.
    const stored = deflated.length >= entry.data.length;
    const body = stored ? Buffer.from(entry.data) : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...chunks, directory, end]);
  if (archive.length > MAX_ZIP_BYTES) {
    throw new Error('The archive is too large for a ZIP file');
  }
  return archive;
}

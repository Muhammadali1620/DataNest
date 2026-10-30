// A ZIP written as it goes (V5.4), for an .xlsx whose sheet is larger than memory:
// a file's sizes and CRC follow its data in a data descriptor, so nothing has to be
// known in advance. Each part is deflated on its own and flushed to a byte boundary;
// one empty final block ends the file, which is a valid deflate stream.

import { constants, deflateRawSync } from 'node:zlib';
import { crc32Update, dosDateTime, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from './zip';
import { msg } from '../core/user-message';

export type ByteWriter = (data: Uint8Array) => Promise<void>;

interface Written {
  readonly name: Buffer;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
  readonly descriptor: boolean;
}

/** Flag bit 3: sizes and CRC come after the data. Bit 11: names are UTF-8. */
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

export class ZipStream {
  private readonly written: Written[] = [];
  private offset = 0;
  private readonly stamp: { time: number; date: number };
  private open = false;

  constructor(
    private readonly write: ByteWriter,
    now: Date = new Date(),
  ) {
    this.stamp = dosDateTime(now);
  }

  /** A small file whose bytes are all at hand. */
  async addFile(name: string, data: Uint8Array): Promise<void> {
    this.checkClosed();
    const body = deflateRawSync(data);
    const crc = crc32Update(0, data);
    const encoded = Buffer.from(name, 'utf8');
    await this.emit(this.localHeader(encoded, FLAG_UTF8, crc, body.length, data.length));
    const start = this.offset - 30 - encoded.length;
    await this.emit(body);
    this.remember({
      name: encoded,
      crc,
      compressed: body.length,
      size: data.length,
      offset: start,
      descriptor: false,
    });
  }

  /** Starts a file written in parts; the next files wait until `end()` of this one. */
  async beginFile(name: string): Promise<{
    write: (data: Uint8Array) => Promise<void>;
    end: () => Promise<void>;
  }> {
    this.checkClosed();
    this.open = true;
    const encoded = Buffer.from(name, 'utf8');
    const start = this.offset;
    await this.emit(this.localHeader(encoded, FLAG_UTF8 | FLAG_DESCRIPTOR, 0, 0, 0));
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const part = async (data: Uint8Array, final: boolean): Promise<void> => {
      const body = deflateRawSync(data, {
        finishFlush: final ? constants.Z_FINISH : constants.Z_SYNC_FLUSH,
      });
      crc = crc32Update(crc, data);
      size += data.length;
      compressed += body.length;
      if (size > MAX_ZIP_BYTES || this.offset + body.length > MAX_ZIP_BYTES) {
        throw new Error(msg('The file is too large for a ZIP archive without ZIP64'));
      }
      await this.emit(body);
    };
    return {
      write: async (data) => {
        if (data.length > 0) {
          await part(data, false);
        }
      },
      end: async () => {
        // An empty final block ends the deflate stream of this file.
        await part(new Uint8Array(0), true);
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        await this.emit(descriptor);
        this.remember({ name: encoded, crc, compressed, size, offset: start, descriptor: true });
        this.open = false;
      },
    };
  }

  /** Writes the central directory; the archive is complete after this. */
  async finish(): Promise<void> {
    this.checkClosed();
    const directoryStart = this.offset;
    for (const entry of this.written) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(FLAG_UTF8 | (entry.descriptor ? FLAG_DESCRIPTOR : 0), 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(this.stamp.time, 12);
      header.writeUInt16LE(this.stamp.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      await this.emit(Buffer.concat([header, entry.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.written.length, 8);
    end.writeUInt16LE(this.written.length, 10);
    end.writeUInt32LE(this.offset - directoryStart, 12);
    end.writeUInt32LE(directoryStart, 16);
    await this.emit(end);
  }

  private localHeader(
    name: Buffer,
    flags: number,
    crc: number,
    compressed: number,
    size: number,
  ): Buffer {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    return Buffer.concat([header, name]);
  }

  private remember(entry: Written): void {
    if (this.written.length >= MAX_ZIP_ENTRIES) {
      throw new Error(msg('Too many files for a ZIP archive'));
    }
    this.written.push(entry);
  }

  private checkClosed(): void {
    if (this.open) {
      throw new Error(msg('The previous file of the archive is still being written'));
    }
  }

  private async emit(data: Uint8Array): Promise<void> {
    this.offset += data.length;
    if (this.offset > MAX_ZIP_BYTES) {
      throw new Error(msg('The file is too large for a ZIP archive without ZIP64'));
    }
    await this.write(data);
  }
}

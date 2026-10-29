// Writing a large text file in pieces (V5.2): small writes are gathered, the disk
// sets the pace, and the file appears under its name only once it is complete, so a
// cancelled or failed dump never leaves half a file where an old one used to be.

import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

/** Where generated text goes; the dump does not care whether it is a file. */
export interface TextSink {
  write(text: string): Promise<void>;
}

/** Text is gathered up to this size before it goes to the stream. */
const FLUSH_CHARS = 64 * 1024;

/** The suffix of the file being written, next to its final name. */
export const PART_SUFFIX = '.datanest-part';

export class FileSink implements TextSink {
  private pending: string[] = [];
  private pendingChars = 0;
  private written = 0;
  private failure: Error | undefined;

  private constructor(
    private readonly path: string,
    private readonly stream: WriteStream,
  ) {
    stream.on('error', (error) => {
      this.failure = error;
    });
  }

  /** Opens the part file next to `path`; fails at once when it cannot be created. */
  static async create(path: string): Promise<FileSink> {
    const stream = createWriteStream(`${path}${PART_SUFFIX}`);
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => {
        resolve();
      });
      stream.once('error', reject);
    });
    return new FileSink(path, stream);
  }

  /** Bytes handed to the file so far. */
  get bytes(): number {
    return this.written;
  }

  async write(text: string): Promise<void> {
    this.pending.push(text);
    this.pendingChars += text.length;
    if (this.pendingChars >= FLUSH_CHARS) {
      await this.flush();
    }
  }

  /** Bytes as they are, after any text written before them. */
  async writeBytes(data: Uint8Array): Promise<void> {
    await this.flush();
    await this.writeChunk(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  /** Writes what is left and puts the file in place under its name. */
  async close(): Promise<void> {
    await this.flush();
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(() => {
        resolve();
      });
    });
    this.check();
    await rename(`${this.path}${PART_SUFFIX}`, this.path);
  }

  /** Throws the part file away; the target, if it existed, stays as it was. */
  async discard(): Promise<void> {
    this.pending = [];
    await new Promise<void>((resolve) => {
      this.stream.destroy();
      if (this.stream.closed) {
        resolve();
      } else {
        this.stream.once('close', () => {
          resolve();
        });
      }
    });
    await rm(`${this.path}${PART_SUFFIX}`, { force: true });
  }

  private async flush(): Promise<void> {
    this.check();
    if (this.pending.length === 0) {
      return;
    }
    const chunk = Buffer.from(this.pending.join(''), 'utf8');
    this.pending = [];
    this.pendingChars = 0;
    await this.writeChunk(chunk);
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    this.check();
    this.written += chunk.length;
    if (!this.stream.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          this.stream.off('drain', onDrain);
          reject(error);
        };
        const onDrain = (): void => {
          this.stream.off('error', onError);
          resolve();
        };
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
      });
    }
    this.check();
  }

  private check(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }
}

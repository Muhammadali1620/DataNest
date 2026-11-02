// The wire format of ZooKeeper ("jute", V13.24): big-endian integers, strings and byte
// buffers with a 4-byte length (`-1` for null), vectors with a 4-byte count, and booleans
// of one byte. Only what the browser needs is here.

import type { ZookeeperAcl, ZookeeperStat } from '../zookeeper-driver';

/** A frame bigger than this is refused (the server's `jute.maxbuffer` is 1 MB by default). */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class JuteWriter {
  private readonly chunks: Buffer[] = [];

  int(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    this.chunks.push(buffer);
    return this;
  }

  long(value: bigint): this {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(value);
    this.chunks.push(buffer);
    return this;
  }

  bool(value: boolean): this {
    this.chunks.push(Buffer.from([value ? 1 : 0]));
    return this;
  }

  bytes(value: Uint8Array | null): this {
    if (value === null) {
      return this.int(-1);
    }
    this.int(value.length);
    this.chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return this;
  }

  string(value: string | null): this {
    return this.bytes(value === null ? null : Buffer.from(value, 'utf8'));
  }

  acl(list: readonly ZookeeperAcl[]): this {
    this.int(list.length);
    for (const entry of list) {
      this.int(entry.perms).string(entry.scheme).string(entry.id);
    }
    return this;
  }

  stat(stat: ZookeeperStat): this {
    return this.long(BigInt(stat.czxid))
      .long(BigInt(stat.mzxid))
      .long(BigInt(stat.ctime))
      .long(BigInt(stat.mtime))
      .int(stat.version)
      .int(stat.cversion)
      .int(stat.aversion)
      .long(BigInt.asIntN(64, BigInt(stat.ephemeralOwner)))
      .int(stat.dataLength)
      .int(stat.numChildren)
      .long(BigInt(stat.pzxid));
  }

  /** What was written. */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** What was written, with the 4-byte length in front, as it goes on the wire. */
  frame(): Buffer {
    const body = this.toBuffer();
    const head = Buffer.alloc(4);
    head.writeInt32BE(body.length);
    return Buffer.concat([head, body]);
  }
}

export class JuteReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  private need(count: number): void {
    if (count < 0 || this.offset + count > this.buffer.length) {
      throw new RangeError('The ZooKeeper answer is shorter than it should be');
    }
  }

  int(): number {
    this.need(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  long(): bigint {
    this.need(8);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    this.need(1);
    const value = this.buffer.readUInt8(this.offset) !== 0;
    this.offset += 1;
    return value;
  }

  /** A byte buffer; null when the length is `-1`. */
  bytes(): Buffer | null {
    const length = this.int();
    if (length < 0) {
      return null;
    }
    this.need(length);
    const value = Buffer.from(this.buffer.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  string(): string {
    return this.bytes()?.toString('utf8') ?? '';
  }

  stringList(): string[] {
    const count = this.int();
    const list: string[] = [];
    for (let index = 0; index < count; index += 1) {
      list.push(this.string());
    }
    return list;
  }

  aclList(): ZookeeperAcl[] {
    const count = this.int();
    const list: ZookeeperAcl[] = [];
    for (let index = 0; index < count; index += 1) {
      list.push({ perms: this.int(), scheme: this.string(), id: this.string() });
    }
    return list;
  }

  /** The 68 bytes of a `Stat`. */
  stat(): ZookeeperStat {
    const czxid = this.long();
    const mzxid = this.long();
    const ctime = this.long();
    const mtime = this.long();
    const version = this.int();
    const cversion = this.int();
    const aversion = this.int();
    const ephemeralOwner = this.long();
    const dataLength = this.int();
    const numChildren = this.int();
    const pzxid = this.long();
    return {
      czxid: czxid.toString(),
      mzxid: mzxid.toString(),
      pzxid: pzxid.toString(),
      ctime: Number(ctime),
      mtime: Number(mtime),
      version,
      cversion,
      aversion,
      ephemeralOwner: BigInt.asUintN(64, ephemeralOwner).toString(),
      dataLength,
      numChildren,
    };
  }
}

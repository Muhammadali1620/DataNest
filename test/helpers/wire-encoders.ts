// Writers of Avro and Protobuf bytes for the tests (V13.34): the extension only reads these
// formats, so the tests need the other direction to make messages like an application would.

/** An Avro `int` or `long`: a zig-zag varint. */
export function avroLong(value: bigint | number): Buffer {
  let n = BigInt(value);
  n = (n << 1n) ^ (n < 0n ? -1n : 0n);
  const out: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (n !== 0n);
  return Buffer.from(out);
}

export function avroString(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([avroLong(bytes.length), bytes]);
}

/** The Confluent wire format: a zero byte, the schema id (4 bytes), then the data. */
export function framed(id: number, ...parts: Buffer[]): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(id, 1);
  return Buffer.concat([head, ...parts]);
}

export function varint(value: bigint | number): Buffer {
  let n = BigInt(value);
  if (n < 0n) {
    n = BigInt.asUintN(64, n);
  }
  const out: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (n !== 0n);
  return Buffer.from(out);
}

/** A Protobuf field with a varint value. */
export function pbVarint(field: number, value: bigint | number): Buffer {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

/** A Protobuf field with a length-delimited value (string, bytes, message, packed). */
export function pbBytes(field: number, bytes: Buffer | string): Buffer {
  const body = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
}

export function pbFixed32(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 5), value]);
}

export function pbFixed64(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 1), value]);
}

/** The Protobuf message-index header: a single `0` byte stands for [0]. */
export function pbIndexes(path: number[]): Buffer {
  if (path.length === 1 && path[0] === 0) {
    return Buffer.from([0]);
  }
  const zig = (n: number): Buffer => avroLong(n);
  return Buffer.concat([zig(path.length), ...path.map(zig)]);
}

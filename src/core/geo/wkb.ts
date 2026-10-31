// Spatial values as people read them (V10.2.4): Well-Known Binary to Well-Known Text,
// e.g. `POINT(1 2)`. MySQL and MariaDB store a geometry as a 4-byte SRID followed by
// WKB; a value that does not read cleanly gives undefined, never a guess.

/** Deepest nesting of collections read; real data never comes close. */
const MAX_DEPTH = 32;

const TYPES = [
  undefined,
  'POINT',
  'LINESTRING',
  'POLYGON',
  'MULTIPOINT',
  'MULTILINESTRING',
  'MULTIPOLYGON',
  'GEOMETRYCOLLECTION',
] as const;

class Reader {
  offset: number;
  little = true;

  constructor(
    private readonly view: DataView,
    offset: number,
  ) {
    this.offset = offset;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  byte(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  uint32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, this.little);
    this.offset += 4;
    return value;
  }

  double(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, this.little);
    this.offset += 8;
    return value;
  }

  /** A count of things that each take at least `size` bytes: more than fit is corrupt. */
  count(size: number): number {
    const count = this.uint32();
    if (count * size > this.remaining) {
      throw new RangeError('count past the end');
    }
    return count;
  }

  private need(bytes: number): void {
    if (this.remaining < bytes) {
      throw new RangeError('value ends early');
    }
  }
}

/** A coordinate written as short as it reads back: `1`, `-0.5`, `1e+21`. */
function coordinate(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError('not a coordinate');
  }
  return Object.is(value, -0) ? '0' : String(value);
}

function point(reader: Reader): string {
  return `${coordinate(reader.double())} ${coordinate(reader.double())}`;
}

function points(reader: Reader): string {
  const count = reader.count(16);
  const list: string[] = [];
  for (let index = 0; index < count; index++) {
    list.push(point(reader));
  }
  return `(${list.join(', ')})`;
}

function rings(reader: Reader): string {
  const count = reader.count(4);
  const list: string[] = [];
  for (let index = 0; index < count; index++) {
    list.push(points(reader));
  }
  return `(${list.join(', ')})`;
}

/** One geometry with its own byte order and type; its text without the type for members. */
function geometry(reader: Reader, depth: number): { type: string; body: string } {
  if (depth > MAX_DEPTH) {
    throw new RangeError('nested too deeply');
  }
  const order = reader.byte();
  if (order !== 0 && order !== 1) {
    throw new RangeError('not a byte order');
  }
  reader.little = order === 1;
  const type = TYPES[reader.uint32()];
  switch (type) {
    case 'POINT': {
      const x = reader.double();
      const y = reader.double();
      // An empty point is written as two NaN coordinates.
      return Number.isNaN(x) && Number.isNaN(y)
        ? { type, body: ' EMPTY' }
        : { type, body: `(${coordinate(x)} ${coordinate(y)})` };
    }
    case 'LINESTRING':
      return { type, body: emptyOr(points(reader)) };
    case 'POLYGON':
      return { type, body: emptyOr(rings(reader)) };
    case 'MULTIPOINT':
    case 'MULTILINESTRING':
    case 'MULTIPOLYGON':
    case 'GEOMETRYCOLLECTION': {
      const count = reader.count(5);
      const members: string[] = [];
      for (let index = 0; index < count; index++) {
        const member = geometry(reader, depth + 1);
        // Members of a multi-geometry are written without their type; a collection keeps it.
        members.push(type === 'GEOMETRYCOLLECTION' ? `${member.type}${member.body}` : member.body);
      }
      return { type, body: members.length === 0 ? ' EMPTY' : `(${members.join(', ')})` };
    }
    case undefined:
      throw new RangeError('not a geometry type');
  }
}

function emptyOr(body: string): string {
  return body === '()' ? ' EMPTY' : body;
}

/** The text of a WKB value that fills `bytes` from `offset` exactly; undefined otherwise. */
export function wkbToWkt(bytes: Uint8Array, offset = 0): string | undefined {
  try {
    const reader = new Reader(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset,
    );
    const { type, body } = geometry(reader, 0);
    return reader.remaining === 0 ? `${type}${body}` : undefined;
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * A MySQL or MariaDB geometry: `SRID=4326;POINT(1 2)` (the SRID only when there is one),
 * undefined when the bytes are not one.
 */
export function mysqlGeometryText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 4 + 5) {
    return undefined;
  }
  const srid = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const wkt = wkbToWkt(bytes, 4);
  return wkt === undefined ? undefined : srid === 0 ? wkt : `SRID=${srid};${wkt}`;
}

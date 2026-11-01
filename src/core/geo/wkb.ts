// Spatial values as people read them (V10.2.4, V13.13): Well-Known Binary to Well-Known
// Text, e.g. `POINT(1 2)`. MySQL and MariaDB store a geometry as a 4-byte SRID followed
// by WKB; PostGIS writes extended WKB (EWKB, in hex): the SRID and the Z and M
// dimensions are flags of the type word. A value that does not read cleanly gives
// undefined, never a guess.

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

/** Ordinates after x and y: one for Z or M, two for both. */
type Extra = 0 | 1 | 2;

function point(reader: Reader, extra: Extra): string {
  const parts: string[] = [];
  for (let index = 0; index < 2 + extra; index++) {
    parts.push(coordinate(reader.double()));
  }
  return parts.join(' ');
}

function points(reader: Reader, extra: Extra): string {
  const count = reader.count(16 + 8 * extra);
  const list: string[] = [];
  for (let index = 0; index < count; index++) {
    list.push(point(reader, extra));
  }
  return `(${list.join(', ')})`;
}

function rings(reader: Reader, extra: Extra): string {
  const count = reader.count(4);
  const list: string[] = [];
  for (let index = 0; index < count; index++) {
    list.push(points(reader, extra));
  }
  return `(${list.join(', ')})`;
}

const SRID_FLAG = 0x2000_0000;
const Z_FLAG = 0x8000_0000;
const M_FLAG = 0x4000_0000;

/**
 * The type word of a geometry: the type code, which of Z and M it has, and whether an
 * SRID follows. EWKB sets flags in the high bits; ISO WKB adds 1000 (Z), 2000 (M) or 3000.
 */
function typeWord(word: number): { code: number; z: boolean; m: boolean; srid: boolean } {
  let z = (word & Z_FLAG) !== 0;
  let m = (word & M_FLAG) !== 0;
  const srid = (word & SRID_FLAG) !== 0;
  let code = word & 0x0fff_ffff;
  const iso = Math.floor(code / 1000);
  if (iso > 3) {
    return { code: -1, z, m, srid };
  }
  code %= 1000;
  z ||= iso === 1 || iso === 3;
  m ||= iso === 2 || iso === 3;
  return { code, z, m, srid };
}

/** One geometry read: its type, its `Z`/`M`/`ZM` mark, and its `(…)` body (empty for EMPTY). */
interface Part {
  readonly type: string;
  readonly flags: string;
  readonly body: string;
}

function render(part: Part): string {
  const flags = part.flags === '' ? '' : ` ${part.flags}`;
  if (part.body === '') {
    return `${part.type}${flags} EMPTY`;
  }
  return `${part.type}${flags}${flags === '' ? '' : ' '}${part.body}`;
}

/** One geometry with its own byte order and type. */
function geometry(reader: Reader, depth: number, found: { srid?: number }): Part {
  if (depth > MAX_DEPTH) {
    throw new RangeError('nested too deeply');
  }
  const order = reader.byte();
  if (order !== 0 && order !== 1) {
    throw new RangeError('not a byte order');
  }
  reader.little = order === 1;
  const word = typeWord(reader.uint32());
  if (word.srid) {
    // Only the outermost geometry's SRID counts; a member may repeat it.
    const srid = reader.uint32();
    if (depth === 0) {
      found.srid = srid;
    }
  }
  const type = TYPES[word.code];
  const extra = ((word.z ? 1 : 0) + (word.m ? 1 : 0)) as Extra;
  const flags = `${word.z ? 'Z' : ''}${word.m ? 'M' : ''}`;
  switch (type) {
    case 'POINT': {
      const coordinates: number[] = [];
      for (let index = 0; index < 2 + extra; index++) {
        coordinates.push(reader.double());
      }
      // An empty point is written as NaN coordinates.
      return coordinates.every(Number.isNaN)
        ? { type, flags, body: '' }
        : { type, flags, body: `(${coordinates.map(coordinate).join(' ')})` };
    }
    case 'LINESTRING':
      return { type, flags, body: emptyOr(points(reader, extra)) };
    case 'POLYGON':
      return { type, flags, body: emptyOr(rings(reader, extra)) };
    case 'MULTIPOINT':
    case 'MULTILINESTRING':
    case 'MULTIPOLYGON':
    case 'GEOMETRYCOLLECTION': {
      const count = reader.count(5);
      const members: string[] = [];
      for (let index = 0; index < count; index++) {
        const member = geometry(reader, depth + 1, found);
        // Members of a multi-geometry are written without their type; a collection keeps it.
        members.push(
          type === 'GEOMETRYCOLLECTION'
            ? render(member)
            : member.body === ''
              ? 'EMPTY'
              : member.body,
        );
      }
      return { type, flags, body: members.length === 0 ? '' : `(${members.join(', ')})` };
    }
    case undefined:
      throw new RangeError('not a geometry type');
  }
}

function emptyOr(body: string): string {
  return body === '()' ? '' : body;
}

/** The text and the SRID of a WKB value that fills `bytes` from `offset` exactly. */
function readWkb(bytes: Uint8Array, offset: number): { wkt: string; srid?: number } | undefined {
  try {
    const reader = new Reader(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset,
    );
    const found: { srid?: number } = {};
    const part = geometry(reader, 0, found);
    return reader.remaining === 0
      ? { wkt: render(part), ...(found.srid === undefined ? {} : { srid: found.srid }) }
      : undefined;
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

/** The text of a WKB value that fills `bytes` from `offset` exactly; undefined otherwise. */
export function wkbToWkt(bytes: Uint8Array, offset = 0): string | undefined {
  return readWkb(bytes, offset)?.wkt;
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

/** Hex digits to bytes; undefined when the text is not a non-empty even run of them. */
function fromHex(text: string): Uint8Array | undefined {
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(text)) {
    return undefined;
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * A PostGIS geometry or geography, which the server sends as hex EWKB, as extended WKT:
 * `SRID=4326;POINT(1 2)` (the SRID only when there is one). PostGIS reads that text back
 * as a value, so a cell shown this way can be edited and copied as it is. Undefined for
 * what is not a plain geometry (curves, TIN, a damaged value): the hex then stays as it is.
 */
export function postgisGeometryText(hex: string): string | undefined {
  const bytes = fromHex(hex);
  const read = bytes === undefined ? undefined : readWkb(bytes, 0);
  if (read === undefined) {
    return undefined;
  }
  return read.srid === undefined || read.srid === 0 ? read.wkt : `SRID=${read.srid};${read.wkt}`;
}

/** Names of the types that hold geometry, in MySQL's and PostGIS's spelling. */
const SPATIAL_TYPES: ReadonlySet<string> = new Set([
  'geometry',
  'geography',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection',
]);

/**
 * Whether a column type, as the database reports it, holds spatial values: `geometry`,
 * `point`, `multipolygon` in MySQL, `geometry(Point,4326)` or `geography` in PostGIS.
 */
export function isSpatialType(dataType: string): boolean {
  const name = /^\s*"?([a-z]+)"?/iu.exec(dataType)?.[1]?.toLowerCase();
  return name !== undefined && SPATIAL_TYPES.has(name);
}

const SRID_PREFIX = /^\s*SRID=(\d{1,10})\s*;\s*/iu;

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/u;

type Token = string | number;

/** Words, numbers and the three punctuation marks of WKT; undefined for anything else. */
function wktTokens(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  let rest = text.trim();
  while (rest !== '') {
    const mark = rest[0];
    if (mark === '(' || mark === ')' || mark === ',') {
      tokens.push(mark);
      rest = rest.slice(1).trimStart();
      continue;
    }
    const word = /^[A-Za-z]+/u.exec(rest)?.[0];
    if (word !== undefined) {
      tokens.push(word.toUpperCase());
      rest = rest.slice(word.length).trimStart();
      continue;
    }
    const number = NUMBER.exec(rest)?.[0];
    if (number === undefined || !Number.isFinite(Number(number))) {
      return undefined;
    }
    tokens.push(Number(number));
    rest = rest.slice(number.length).trimStart();
  }
  return tokens;
}

/** Collects the bytes of a WKB value while a WKT text is read. */
class WkbWriter {
  readonly bytes: number[] = [];

  uint32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value, true);
    this.bytes.push(...new Uint8Array(view.buffer));
  }

  double(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    this.bytes.push(...new Uint8Array(view.buffer));
  }

  header(type: number): void {
    this.bytes.push(1);
    this.uint32(type);
  }
}

/** A recursive-descent reader of 2D WKT that writes WKB as it goes. */
class WktReader {
  private position = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly out: WkbWriter,
  ) {}

  get done(): boolean {
    return this.position >= this.tokens.length;
  }

  private next(): Token {
    const token = this.tokens[this.position++];
    if (token === undefined) {
      throw new RangeError('text ends early');
    }
    return token;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private expect(mark: string): void {
    if (this.next() !== mark) {
      throw new RangeError(`expected ${mark}`);
    }
  }

  private number(): number {
    const token = this.next();
    if (typeof token !== 'number') {
      throw new RangeError('expected a number');
    }
    return token;
  }

  private point(): void {
    this.out.double(this.number());
    this.out.double(this.number());
  }

  /** `item, item, …` up to the closing mark, counted first because WKB leads with the count. */
  private list(item: () => void, openedAlready = false): void {
    if (!openedAlready) {
      this.expect('(');
    }
    const start = this.out.bytes.length;
    this.out.uint32(0);
    let count = 0;
    do {
      item();
      count += 1;
    } while (this.peek() === ',' && this.next() === ',');
    this.expect(')');
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, count, true);
    this.out.bytes.splice(start, 4, ...new Uint8Array(view.buffer));
  }

  private points(): void {
    this.list(() => {
      this.point();
    });
  }

  private rings(): void {
    this.list(() => {
      this.points();
    });
  }

  /** One geometry, with the type it names; `depth` bounds collections inside collections. */
  geometry(depth: number): void {
    if (depth > MAX_DEPTH) {
      throw new RangeError('nested too deeply');
    }
    const name = this.next();
    if (typeof name !== 'string') {
      throw new RangeError('expected a type');
    }
    // MySQL has no Z or M: a mark means a value it cannot hold.
    if (this.peek() === 'EMPTY') {
      this.next();
      if (name === 'GEOMETRYCOLLECTION') {
        this.out.header(7);
        this.out.uint32(0);
        return;
      }
      throw new RangeError('only an empty collection exists');
    }
    switch (name) {
      case 'POINT':
        this.out.header(1);
        this.expect('(');
        this.point();
        this.expect(')');
        return;
      case 'LINESTRING':
        this.out.header(2);
        this.points();
        return;
      case 'POLYGON':
        this.out.header(3);
        this.rings();
        return;
      case 'MULTIPOINT':
        this.out.header(4);
        this.list(() => {
          // Written as (1 2) or as 1 2.
          const wrapped = this.peek() === '(';
          if (wrapped) {
            this.next();
          }
          this.out.header(1);
          this.point();
          if (wrapped) {
            this.expect(')');
          }
        });
        return;
      case 'MULTILINESTRING':
        this.out.header(5);
        this.list(() => {
          this.out.header(2);
          this.points();
        });
        return;
      case 'MULTIPOLYGON':
        this.out.header(6);
        this.list(() => {
          this.out.header(3);
          this.rings();
        });
        return;
      case 'GEOMETRYCOLLECTION':
      case 'GEOMCOLLECTION':
        this.out.header(7);
        this.list(() => {
          this.geometry(depth + 1);
        });
        return;
      default:
        throw new RangeError('not a geometry type');
    }
  }
}

/**
 * A geometry written as `SRID=4326;POINT(1 2)` (the SRID optional) in the form MySQL and
 * MariaDB keep it in: four bytes of SRID and little-endian WKB. A server takes that
 * binary as the value of a spatial column as it is, in the axis order it stores, so the
 * text the driver showed (V10.2.4) goes back unchanged. Undefined for anything that is not
 * a plain 2D geometry the servers can hold; nothing but a geometry can come out, so what
 * goes into a generated statement is bytes, not text.
 */
export function wktToMysqlGeometry(text: string): Uint8Array | undefined {
  const prefix = SRID_PREFIX.exec(text);
  const srid = prefix === null ? 0 : Number(prefix[1]);
  if (!Number.isInteger(srid) || srid > 0xffff_ffff) {
    return undefined;
  }
  const tokens = wktTokens(prefix === null ? text : text.slice(prefix[0].length));
  if (tokens === undefined) {
    return undefined;
  }
  const out = new WkbWriter();
  out.uint32(srid);
  try {
    const reader = new WktReader(tokens, out);
    reader.geometry(0);
    return reader.done ? Uint8Array.from(out.bytes) : undefined;
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

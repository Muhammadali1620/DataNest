import { describe, expect, it } from 'vitest';
import {
  isSpatialType,
  mysqlGeometryText,
  postgisGeometryText,
  wktToMysqlGeometry,
  wkbToWkt,
} from '../../../../src/core/geo/wkb';

/** Builds WKB the way servers write it, in either byte order. */
class Wkb {
  private readonly bytes: number[] = [];

  constructor(private readonly little = true) {}

  header(type: number): this {
    this.bytes.push(this.little ? 1 : 0);
    return this.uint32(type);
  }

  uint32(value: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value, this.little);
    this.bytes.push(...new Uint8Array(view.buffer));
    return this;
  }

  double(...values: number[]): this {
    for (const value of values) {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value, this.little);
      this.bytes.push(...new Uint8Array(view.buffer));
    }
    return this;
  }

  point(x: number, y: number): this {
    return this.header(1).double(x, y);
  }

  line(...coordinates: number[][]): this {
    this.header(2).uint32(coordinates.length);
    for (const [x = 0, y = 0] of coordinates) {
      this.double(x, y);
    }
    return this;
  }

  raw(...bytes: number[]): this {
    this.bytes.push(...bytes);
    return this;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function wkt(build: (wkb: Wkb) => Wkb, little = true): string | undefined {
  return wkbToWkt(build(new Wkb(little)).done());
}

describe('wkbToWkt', () => {
  it('reads a point in either byte order', () => {
    expect(wkt((w) => w.point(1, 2))).toBe('POINT(1 2)');
    expect(wkt((w) => w.point(-73.9857, 40.7484), false)).toBe('POINT(-73.9857 40.7484)');
  });

  it('writes coordinates as short as they read back', () => {
    expect(wkt((w) => w.point(0.1, 1e21))).toBe('POINT(0.1 1e+21)');
    expect(wkt((w) => w.point(-0, 3))).toBe('POINT(0 3)');
  });

  it('reads an empty point, written as NaN coordinates', () => {
    expect(wkt((w) => w.point(Number.NaN, Number.NaN))).toBe('POINT EMPTY');
  });

  it('reads lines and polygons with their rings', () => {
    expect(wkt((w) => w.line([0, 0], [1, 1], [2, 0]))).toBe('LINESTRING(0 0, 1 1, 2 0)');
    expect(wkt((w) => w.header(2).uint32(0))).toBe('LINESTRING EMPTY');
    const polygon = wkt((w) =>
      w
        .header(3)
        .uint32(2)
        .uint32(4)
        .double(0, 0, 4, 0, 4, 4, 0, 0)
        .uint32(4)
        .double(1, 1, 2, 1, 2, 2, 1, 1),
    );
    expect(polygon).toBe('POLYGON((0 0, 4 0, 4 4, 0 0), (1 1, 2 1, 2 2, 1 1))');
  });

  it('reads multi-geometries without their members’ types', () => {
    expect(wkt((w) => w.header(4).uint32(2).point(1, 2).point(3, 4))).toBe(
      'MULTIPOINT((1 2), (3 4))',
    );
    expect(wkt((w) => w.header(5).uint32(1).line([0, 0], [1, 1]))).toBe(
      'MULTILINESTRING((0 0, 1 1))',
    );
    expect(
      wkt((w) =>
        w.header(6).uint32(1).header(3).uint32(1).uint32(4).double(0, 0, 1, 0, 1, 1, 0, 0),
      ),
    ).toBe('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)))');
    expect(wkt((w) => w.header(4).uint32(0))).toBe('MULTIPOINT EMPTY');
  });

  it('reads a collection with the type of each member, nested too', () => {
    expect(
      wkt((w) =>
        w.header(7).uint32(3).point(1, 2).line([0, 0], [1, 1]).header(7).uint32(1).point(5, 6),
      ),
    ).toBe('GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1), GEOMETRYCOLLECTION(POINT(5 6)))');
  });

  it('lets each member have its own byte order', () => {
    const big = new Wkb(false).point(3, 4).done();
    const mixed = new Wkb(true)
      .header(4)
      .uint32(2)
      .point(1, 2)
      .raw(...big)
      .done();
    expect(wkbToWkt(mixed)).toBe('MULTIPOINT((1 2), (3 4))');
  });

  it('refuses bytes that are not exactly one geometry', () => {
    expect(wkbToWkt(new Uint8Array())).toBeUndefined();
    expect(wkt((w) => w.point(1, 2).raw(0))).toBeUndefined();
    expect(wkt((w) => w.header(1).double(1))).toBeUndefined();
    expect(wkt((w) => w.header(99).double(1, 2))).toBeUndefined();
    expect(wkt((w) => w.raw(7).uint32(1).double(1, 2))).toBeUndefined();
    expect(wkt((w) => w.header(2).uint32(1_000_000).double(1, 2))).toBeUndefined();
    expect(wkt((w) => w.point(Number.POSITIVE_INFINITY, 1))).toBeUndefined();
  });

  it('refuses collections nested past any real use', () => {
    const deep = new Wkb();
    for (let level = 0; level < 40; level++) {
      deep.header(7).uint32(1);
    }
    expect(wkbToWkt(deep.point(1, 1).done())).toBeUndefined();
  });

  it('reads from an offset into the bytes', () => {
    const bytes = new Wkb().raw(9, 9, 9).point(1, 2).done();
    expect(wkbToWkt(bytes, 3)).toBe('POINT(1 2)');
  });
});

describe('mysqlGeometryText', () => {
  function stored(srid: number, build: (wkb: Wkb) => Wkb): Uint8Array {
    return new Wkb()
      .uint32(srid)
      .raw(...build(new Wkb()).done())
      .done();
  }

  it('reads the SRID in front of the WKB', () => {
    expect(mysqlGeometryText(stored(4326, (w) => w.point(1, 2)))).toBe('SRID=4326;POINT(1 2)');
  });

  it('leaves out an SRID of zero', () => {
    expect(mysqlGeometryText(stored(0, (w) => w.line([0, 0], [1, 1])))).toBe(
      'LINESTRING(0 0, 1 1)',
    );
  });

  it('works on a slice of a larger buffer', () => {
    const value = stored(0, (w) => w.point(5, 6));
    const big = new Uint8Array(value.length + 10);
    big.set(value, 7);
    expect(mysqlGeometryText(big.subarray(7, 7 + value.length))).toBe('POINT(5 6)');
  });

  it('refuses what is too short or not a geometry', () => {
    expect(mysqlGeometryText(Uint8Array.from([0, 0, 0, 0]))).toBeUndefined();
    expect(mysqlGeometryText(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeUndefined();
  });
});

const SRID = 0x2000_0000;
const Z = 0x8000_0000;
const M = 0x4000_0000;

function hex(build: (wkb: Wkb) => Wkb, little = true): string {
  return Buffer.from(build(new Wkb(little)).done()).toString('hex');
}

describe('dimensions of extended and ISO WKB', () => {
  it('reads Z and M from the flags of the type word', () => {
    expect(wkt((w) => w.header((Z | 1) >>> 0).double(1, 2, 3))).toBe('POINT Z (1 2 3)');
    expect(wkt((w) => w.header((M | 1) >>> 0).double(1, 2, 7))).toBe('POINT M (1 2 7)');
    expect(wkt((w) => w.header((Z | M | 1) >>> 0).double(1, 2, 3, 4))).toBe('POINT ZM (1 2 3 4)');
  });

  it('reads Z and M from the ISO type codes', () => {
    expect(wkt((w) => w.header(1001).double(1, 2, 3))).toBe('POINT Z (1 2 3)');
    expect(wkt((w) => w.header(2001).double(1, 2, 3))).toBe('POINT M (1 2 3)');
    expect(wkt((w) => w.header(3001).double(1, 2, 3, 4))).toBe('POINT ZM (1 2 3 4)');
    expect(wkt((w) => w.header(4001).double(1, 2, 3, 4))).toBeUndefined();
  });

  it('reads lines, polygons and multi-geometries with extra ordinates', () => {
    expect(
      wkt((w) =>
        w
          .header((Z | 2) >>> 0)
          .uint32(2)
          .double(0, 0, 1, 1, 1, 2),
      ),
    ).toBe('LINESTRING Z (0 0 1, 1 1 2)');
    expect(
      wkt((w) =>
        w
          .header((Z | 6) >>> 0)
          .uint32(1)
          .header((Z | 3) >>> 0)
          .uint32(1)
          .uint32(3)
          .double(0, 0, 5, 1, 0, 5, 0, 1, 5),
      ),
    ).toBe('MULTIPOLYGON Z (((0 0 5, 1 0 5, 0 1 5)))');
  });

  it('counts the bytes of Z and M points, so a short value is refused', () => {
    expect(
      wkt((w) =>
        w
          .header((Z | 2) >>> 0)
          .uint32(2)
          .double(0, 0, 1, 1, 1),
      ),
    ).toBeUndefined();
  });

  it('writes empty geometries with their marks', () => {
    expect(wkt((w) => w.header((Z | 1) >>> 0).double(NaN, NaN, NaN))).toBe('POINT Z EMPTY');
    expect(wkt((w) => w.header((Z | 2) >>> 0).uint32(0))).toBe('LINESTRING Z EMPTY');
    expect(wkt((w) => w.header(7).uint32(1).header(1).double(NaN, NaN))).toBe(
      'GEOMETRYCOLLECTION(POINT EMPTY)',
    );
    expect(wkt((w) => w.header(4).uint32(1).header(1).double(NaN, NaN))).toBe('MULTIPOINT(EMPTY)');
  });

  it('keeps the marks of the members of a collection', () => {
    expect(
      wkt((w) =>
        w
          .header(7)
          .uint32(2)
          .header((Z | 1) >>> 0)
          .double(1, 2, 3)
          .point(4, 5),
      ),
    ).toBe('GEOMETRYCOLLECTION(POINT Z (1 2 3), POINT(4 5))');
  });
});

describe('postgisGeometryText', () => {
  it('shows a point with its SRID as extended WKT', () => {
    const value = hex((w) =>
      w
        .header((SRID | 1) >>> 0)
        .uint32(4326)
        .double(13.4, 52.5),
    );
    expect(postgisGeometryText(value)).toBe('SRID=4326;POINT(13.4 52.5)');
  });

  it('leaves out a missing or zero SRID', () => {
    expect(postgisGeometryText(hex((w) => w.point(1, 2)))).toBe('POINT(1 2)');
    expect(
      postgisGeometryText(
        hex((w) =>
          w
            .header((SRID | 1) >>> 0)
            .uint32(0)
            .double(1, 2),
        ),
      ),
    ).toBe('POINT(1 2)');
  });

  it('reads either byte order and either case of the hex digits', () => {
    const big = hex(
      (w) =>
        w
          .header((SRID | 1) >>> 0)
          .uint32(3857)
          .double(1.5, -2.5),
      false,
    );
    expect(postgisGeometryText(big)).toBe('SRID=3857;POINT(1.5 -2.5)');
    expect(postgisGeometryText(big.toUpperCase())).toBe('SRID=3857;POINT(1.5 -2.5)');
  });

  it('takes the SRID of the outer geometry when the members repeat it', () => {
    const value = hex((w) =>
      w
        .header((SRID | 4) >>> 0)
        .uint32(4326)
        .uint32(2)
        .header((SRID | 1) >>> 0)
        .uint32(4326)
        .double(1, 2)
        .point(3, 4),
    );
    expect(postgisGeometryText(value)).toBe('SRID=4326;MULTIPOINT((1 2), (3 4))');
  });

  it('reads a polygon with a Z ordinate and an SRID', () => {
    const value = hex((w) =>
      w
        .header((SRID | Z | 3) >>> 0)
        .uint32(4979)
        .uint32(1)
        .uint32(4)
        .double(0, 0, 9, 1, 0, 9, 0, 1, 9, 0, 0, 9),
    );
    expect(postgisGeometryText(value)).toBe('SRID=4979;POLYGON Z ((0 0 9, 1 0 9, 0 1 9, 0 0 9))');
  });

  it('gives undefined for what is not a plain geometry', () => {
    expect(postgisGeometryText('')).toBeUndefined();
    expect(postgisGeometryText('abc')).toBeUndefined();
    expect(postgisGeometryText('zz')).toBeUndefined();
    expect(postgisGeometryText('POINT(1 2)')).toBeUndefined();
    // A circular string (type 8) and a truncated point.
    expect(postgisGeometryText(hex((w) => w.header(8).uint32(0)))).toBeUndefined();
    expect(postgisGeometryText(hex((w) => w.point(1, 2)).slice(0, -2))).toBeUndefined();
  });
});

describe('isSpatialType', () => {
  it('knows the spatial types of MySQL and PostGIS', () => {
    for (const type of [
      'geometry',
      'POINT',
      'linestring',
      'polygon',
      'multipoint',
      'multilinestring',
      'multipolygon',
      'geometrycollection',
      'geomcollection',
      'geometry(Point,4326)',
      'geography(Polygon,4326)',
      'geography',
      '"geometry"',
    ]) {
      expect(isSpatialType(type)).toBe(true);
    }
  });

  it('does not take other types for spatial ones', () => {
    for (const type of ['text', 'varchar(20)', 'pointer', 'geometrycolumn', 'jsonb', '']) {
      expect(isSpatialType(type)).toBe(false);
    }
  });
});

describe('wktToMysqlGeometry', () => {
  /** The text the driver shows for the bytes: what a round trip must give back. */
  function back(text: string): string | undefined {
    const bytes = wktToMysqlGeometry(text);
    return bytes === undefined ? undefined : mysqlGeometryText(bytes);
  }

  it('writes the SRID and little-endian WKB, the form the servers keep', () => {
    const bytes = wktToMysqlGeometry('SRID=4326;POINT(1 2)');
    expect(Buffer.from(bytes ?? []).toString('hex')).toBe(
      'e6100000' + '01' + '01000000' + '000000000000f03f' + '0000000000000040',
    );
    expect(Buffer.from(wktToMysqlGeometry('POINT(1 2)') ?? []).toString('hex')).toBe(
      '00000000' + '01' + '01000000' + '000000000000f03f' + '0000000000000040',
    );
  });

  it('gives back the very text for every kind of geometry', () => {
    for (const text of [
      'SRID=4326;POINT(1 2)',
      'POINT(-0.5 1e+21)',
      'POINT(0.1 -2.5)',
      'LINESTRING(0 0, 1 1, 2 0)',
      'SRID=3857;POLYGON((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 1))',
      'MULTIPOINT((1 2), (3 4))',
      'MULTILINESTRING((0 0, 1 1), (2 2, 3 3))',
      'SRID=4326;MULTIPOLYGON(((0 0, 1 0, 0 1, 0 0)), ((5 5, 6 5, 5 6, 5 5)))',
      'GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1))',
      'GEOMETRYCOLLECTION(GEOMETRYCOLLECTION(POINT(1 2)), POINT(3 4))',
      'GEOMETRYCOLLECTION EMPTY',
    ]) {
      expect(back(text), text).toBe(text);
    }
  });

  it('reads a multipoint written with or without parentheses around its points', () => {
    expect(back('MULTIPOINT(1 2, 3 4)')).toBe('MULTIPOINT((1 2), (3 4))');
  });

  it('accepts any case, spacing and exponent form of a number', () => {
    expect(back('  srid=4326 ; point ( 1.5E2   -.5 ) ')).toBe('SRID=4326;POINT(150 -0.5)');
    expect(back('Point(+1 2.)')).toBe('POINT(1 2)');
  });

  it('refuses what is not a plain 2D geometry, so nothing else is ever written', () => {
    for (const text of [
      '',
      'hello',
      'POINT',
      'POINT(1 2',
      'POINT(1 2))',
      'POINT(1)',
      'POINT(1 2 3)',
      'POINT Z (1 2 3)',
      'POINT M (1 2 3)',
      'POINT EMPTY',
      'LINESTRING EMPTY',
      'POINT(NaN 2)',
      'POINT(Infinity 2)',
      'POINT(1e999 2)',
      "POINT(1 2)'); DROP TABLE t; --",
      'POINT(1 2) extra',
      'POINT(1 2), POINT(3 4)',
      'SRID=abc;POINT(1 2)',
      'SRID=4326 POINT(1 2)',
      'SRID=4294967296;POINT(1 2)',
      'SRID=12345678901;POINT(1 2)',
      'CIRCULARSTRING(0 0, 1 1, 2 0)',
      'SELECT(1)',
      'POINT(1 2) UNION SELECT 1',
      'GEOMETRYCOLLECTION(POINT(1 2)',
      'GEOMETRYCOLLECTION(POINT(1 2),)',
      'POLYGON(0 0, 1 1)',
    ]) {
      expect(wktToMysqlGeometry(text), text).toBeUndefined();
    }
  });

  it('refuses collections nested past any real use', () => {
    const deep = (levels: number): string =>
      `${'GEOMETRYCOLLECTION('.repeat(levels)}POINT(1 2)${')'.repeat(levels)}`;
    expect(wktToMysqlGeometry(deep(5))).toBeDefined();
    expect(wktToMysqlGeometry(deep(40))).toBeUndefined();
  });

  it('takes the biggest SRID there is', () => {
    expect(back('SRID=4294967295;POINT(1 2)')).toBe('SRID=4294967295;POINT(1 2)');
  });
});

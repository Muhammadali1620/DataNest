import { describe, expect, it } from 'vitest';
import { mysqlGeometryText, wkbToWkt } from '../../../../src/core/geo/wkb';

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

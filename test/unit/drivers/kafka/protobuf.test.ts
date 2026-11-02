import { describe, expect, it } from 'vitest';
import { decodeProtobuf, messageAt, parseProto } from '../../../../src/drivers/kafka/protobuf';
import { pbBytes, pbFixed32, pbFixed64, pbVarint, varint } from '../../../helpers/wire-encoders';

const PROTO = `
  // an order
  syntax = "proto3";
  package demo;
  import "google/protobuf/timestamp.proto";
  option java_package = "x.y";

  message Order {
    int32 id = 1;
    string item = 2;
    repeated int32 qty = 3;
    map<string, int64> tags = 4;
    Status st = 5;
    Line line = 6;
    repeated Line more = 7;
    oneof pick { string a = 8; int32 b = 9; }
    google.protobuf.Timestamp at = 10;
    enum Status { NEW = 0; DONE = 1; }
    message Line { string sku = 1; sint32 delta = 2; }
    reserved 20;
  }
  message Other { bool ok = 1; bytes raw = 2; double d = 3; float f = 4; fixed64 big = 5; }
  service Svc { rpc Go (Order) returns (Other); }
`;

const file = parseProto(PROTO);
const read = (path: number[], ...fields: Buffer[]): unknown =>
  decodeProtobuf(file, path, Buffer.concat(fields));

describe('Protobuf decoding (V13.34)', () => {
  it('reads scalars, enums and strings by the names of the .proto', () => {
    expect(read([0], pbVarint(1, 7), pbBytes(2, 'ünï'), pbVarint(5, 1))).toEqual({
      id: 7,
      item: 'ünï',
      st: 'DONE',
    });
  });

  it('shows an enum number that has no name as the number', () => {
    expect(read([0], pbVarint(5, 9))).toEqual({ st: 9 });
  });

  it('reads packed and unpacked repeated numbers, and repeated messages', () => {
    const packed = Buffer.concat([varint(1), varint(2), varint(300)]);
    expect(read([0], pbBytes(3, packed))).toEqual({ qty: [1, 2, 300] });
    expect(read([0], pbVarint(3, 4), pbVarint(3, 5))).toEqual({ qty: [4, 5] });
    expect(
      read(
        [0],
        pbBytes(7, pbBytes(1, 'a')),
        pbBytes(7, Buffer.concat([pbBytes(1, 'b'), pbVarint(2, 3)])),
      ),
    ).toEqual({ more: [{ sku: 'a' }, { sku: 'b', delta: -2 }] });
  });

  it('reads maps into objects', () => {
    const entry = (key: string, value: number): Buffer =>
      pbBytes(4, Buffer.concat([pbBytes(1, key), pbVarint(2, value)]));
    expect(read([0], entry('a', 1), entry('b', 2))).toEqual({ tags: { a: 1, b: 2 } });
  });

  it('reads a nested message and a field of a oneof', () => {
    expect(read([0], pbBytes(6, pbBytes(1, 'sku1')), pbBytes(8, 'x'))).toEqual({
      line: { sku: 'sku1' },
      a: 'x',
    });
  });

  it('reads a message chosen by the index path, nested ones included', () => {
    expect(read([1], pbVarint(1, 1), pbBytes(2, Buffer.from([1, 2])))).toEqual({
      ok: true,
      raw: 'AQI=',
    });
    expect(read([0, 0], pbBytes(1, 'q'), pbVarint(2, 3))).toEqual({ sku: 'q', delta: -2 });
  });

  it('reads the fixed-size numbers', () => {
    const double = Buffer.alloc(8);
    double.writeDoubleLE(2.5);
    const float = Buffer.alloc(4);
    float.writeFloatLE(0.5);
    const big = Buffer.alloc(8);
    big.writeBigUInt64LE(18446744073709551615n);
    expect(read([1], pbFixed64(3, double), pbFixed32(4, float), pbFixed64(5, big))).toEqual({
      d: 2.5,
      f: 0.5,
      big: '18446744073709551615',
    });
  });

  it('shows a negative int32 and a 64-bit number outside the safe range', () => {
    expect(read([0], pbVarint(1, -1))).toEqual({ id: -1 });
    const other = parseProto('message M { int64 a = 1; uint64 b = 2; uint32 c = 3; int32 d = 4; }');
    const bytes = Buffer.concat([
      pbVarint(1, 9007199254740993n),
      pbVarint(2, 18446744073709551615n),
    ]);
    expect(decodeProtobuf(other, [0], bytes)).toEqual({
      a: '9007199254740993',
      b: '18446744073709551615',
    });
  });

  it('shows a field the .proto does not know, or a type it cannot find, by its number', () => {
    expect(read([0], pbVarint(30, 5), pbBytes(31, 'abc'))).toEqual({ '30': 5, '31': 'YWJj' });
    const at = Buffer.concat([pbVarint(1, 12), pbVarint(2, 3)]);
    expect(read([0], pbBytes(10, at))).toEqual({ at: { '1': 12, '2': 3 } });
  });

  it('refuses a path that is not there and bytes that end early', () => {
    expect(() => read([5], pbVarint(1, 1))).toThrow(/not there/u);
    expect(() => messageAt(file, [])).toThrow(/no index/u);
    expect(() => decodeProtobuf(file, [0], Buffer.from([0x0a, 0x09, 0x01]))).toThrow(/ends/u);
    expect(() => decodeProtobuf(file, [0], Buffer.from([0x0b]))).toThrow(/not supported/u);
  });

  it('copes with text that is cut short or oddly written', () => {
    expect(() => parseProto('message M { int32 a')).toThrow(/ends too early/u);
    const odd = parseProto(
      'syntax="proto2"; message M { optional int32 a = 1 [default = 5]; required string b = 2; extensions 100 to 199; }',
    );
    expect(decodeProtobuf(odd, [0], Buffer.concat([pbVarint(1, 4), pbBytes(2, 's')]))).toEqual({
      a: 4,
      b: 's',
    });
  });
});

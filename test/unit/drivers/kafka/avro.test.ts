import { describe, expect, it } from 'vitest';
import { decodeAvro, parseAvroSchema } from '../../../../src/drivers/kafka/avro';
import { avroLong, avroString } from '../../../helpers/wire-encoders';

const read = (schema: unknown, bytes: Buffer): unknown =>
  decodeAvro(parseAvroSchema(schema), bytes);

describe('Avro decoding (V13.34)', () => {
  it('reads the primitive types', () => {
    expect(read('null', Buffer.alloc(0))).toBeNull();
    expect(read('boolean', Buffer.from([1]))).toBe(true);
    expect(read('boolean', Buffer.from([0]))).toBe(false);
    expect(read('int', avroLong(-3))).toBe(-3);
    expect(read('long', avroLong(1234567890123n))).toBe(1234567890123);
    expect(read('string', avroString('héllo ✓'))).toBe('héllo ✓');
    const float = Buffer.alloc(4);
    float.writeFloatLE(1.5);
    expect(read('float', float)).toBe(1.5);
    const double = Buffer.alloc(8);
    double.writeDoubleLE(-2.25);
    expect(read('double', double)).toBe(-2.25);
  });

  it('shows a long beyond the safe range as a string', () => {
    expect(read('long', avroLong(9007199254740993n))).toBe('9007199254740993');
    expect(read('long', avroLong(-9223372036854775808n))).toBe('-9223372036854775808');
  });

  it('shows bytes and fixed as base64', () => {
    expect(read('bytes', Buffer.concat([avroLong(3), Buffer.from([1, 2, 3])]))).toBe('AQID');
    expect(read({ type: 'fixed', name: 'F', size: 2 }, Buffer.from([255, 0]))).toBe('/wA=');
  });

  it('reads a record with nested records, enums, arrays, maps and unions', () => {
    const schema = {
      type: 'record',
      name: 'Order',
      namespace: 'shop',
      fields: [
        { name: 'id', type: 'int' },
        { name: 'status', type: { type: 'enum', name: 'Status', symbols: ['NEW', 'PAID'] } },
        { name: 'lines', type: { type: 'array', items: 'string' } },
        { name: 'tags', type: { type: 'map', values: 'int' } },
        { name: 'note', type: ['null', 'string'] },
        { name: 'again', type: 'shop.Status' },
        {
          name: 'buyer',
          type: { type: 'record', name: 'Buyer', fields: [{ name: 'n', type: 'string' }] },
        },
      ],
    };
    const bytes = Buffer.concat([
      avroLong(7),
      avroLong(1),
      avroLong(2),
      avroString('a'),
      avroString('b'),
      avroLong(0),
      avroLong(1),
      avroString('k'),
      avroLong(9),
      avroLong(0),
      avroLong(1),
      avroString('hi'),
      avroLong(0),
      avroString('Ann'),
    ]);
    expect(read(schema, bytes)).toEqual({
      id: 7,
      status: 'PAID',
      lines: ['a', 'b'],
      tags: { k: 9 },
      note: 'hi',
      again: 'NEW',
      buyer: { n: 'Ann' },
    });
  });

  it('reads blocks that carry their size (a negative count)', () => {
    const bytes = Buffer.concat([avroLong(-2), avroLong(2), avroLong(5), avroLong(6), avroLong(0)]);
    expect(read({ type: 'array', items: 'int' }, bytes)).toEqual([5, 6]);
  });

  it('resolves a type by its short name inside the namespace and by a dotted name', () => {
    const schema = {
      type: 'record',
      name: 'Outer',
      namespace: 'a.b',
      fields: [
        { name: 'x', type: { type: 'enum', name: 'E', symbols: ['ONE'] } },
        { name: 'y', type: 'E' },
        { name: 'z', type: 'a.b.E' },
      ],
    };
    expect(read(schema, Buffer.from([0, 0, 0]))).toEqual({ x: 'ONE', y: 'ONE', z: 'ONE' });
  });

  it('allows a record that refers to itself', () => {
    const schema = {
      type: 'record',
      name: 'Node',
      fields: [
        { name: 'v', type: 'int' },
        { name: 'next', type: ['null', 'Node'] },
      ],
    };
    const bytes = Buffer.concat([avroLong(1), avroLong(1), avroLong(2), avroLong(0)]);
    expect(read(schema, bytes)).toEqual({ v: 1, next: { v: 2, next: null } });
  });

  it('follows a logical type to what it is stored as', () => {
    expect(read({ type: 'long', logicalType: 'timestamp-millis' }, avroLong(1000))).toBe(1000);
  });

  it('refuses bytes that end early, that are left over, or that name a missing branch', () => {
    expect(() => read('string', Buffer.concat([avroLong(5), Buffer.from('ab')]))).toThrow(/ends/u);
    expect(() => read('int', Buffer.from([2, 9]))).toThrow(/left over/u);
    expect(() => read(['null', 'int'], avroLong(5))).toThrow(/union branch/u);
    expect(() => read({ type: 'enum', name: 'E', symbols: ['A'] }, avroLong(3))).toThrow(/enum/u);
    expect(() =>
      read('int', Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])),
    ).toThrow(/too long/u);
    expect(() => read('string', avroLong(-1))).toThrow(/out of range/u);
  });

  it('refuses a schema that is not valid', () => {
    expect(() => parseAvroSchema('nope')).toThrow(/unknown type/u);
    expect(() => parseAvroSchema(5)).toThrow(/not valid/u);
    expect(() => parseAvroSchema({ type: 'record', fields: [] })).toThrow(/no name/u);
    expect(() => parseAvroSchema({ type: 'record', name: 'R', fields: [{ type: 'int' }] })).toThrow(
      /field/u,
    );
    expect(() => parseAvroSchema({ type: 'fixed', name: 'F' })).toThrow(/size/u);
  });

  it('stops a schema or a message nested without end', () => {
    let schema: unknown = 'int';
    for (let index = 0; index < 100; index += 1) {
      schema = { type: 'array', items: schema };
    }
    expect(() => parseAvroSchema(schema)).toThrow(/nested too deeply/u);
    const node = {
      type: 'record',
      name: 'N',
      fields: [{ name: 'n', type: ['null', 'N'] }],
    };
    const deep = Buffer.concat(Array.from({ length: 200 }, () => avroLong(1)));
    expect(() => read(node, deep)).toThrow(/nested too deeply/u);
  });
});

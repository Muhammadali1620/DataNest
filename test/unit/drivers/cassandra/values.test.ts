import { types } from 'cassandra-driver';
import { describe, expect, it } from 'vitest';
import { fromCassandra, jsonText, typeName } from '../../../../src/drivers/cassandra/values';

const {
  Long,
  Integer,
  BigDecimal,
  Uuid,
  TimeUuid,
  InetAddress,
  LocalDate,
  LocalTime,
  Duration,
  Tuple,
} = types;

describe('fromCassandra', () => {
  it('keeps nulls, booleans, text and plain numbers as they are', () => {
    expect(fromCassandra(null)).toBeNull();
    expect(fromCassandra(undefined)).toBeNull();
    expect(fromCassandra(true)).toBe(true);
    expect(fromCassandra('héllo')).toBe('héllo');
    expect(fromCassandra(1.5)).toBe(1.5);
    expect(fromCassandra(Number.NaN)).toBeNaN();
  });

  it('keeps a bigint exact: small ones are numbers, the rest keep their digits', () => {
    expect(fromCassandra(Long.fromString('42'))).toBe(42);
    expect(fromCassandra(Long.fromString('-9007199254740993'))).toEqual({
      kind: 'bigint',
      text: '-9007199254740993',
    });
    expect(fromCassandra(Long.MAX_VALUE)).toEqual({ kind: 'bigint', text: '9223372036854775807' });
    expect(fromCassandra(9007199254740993n)).toEqual({ kind: 'bigint', text: '9007199254740993' });
  });

  it('keeps a varint exact, past any machine integer', () => {
    const huge = Integer.fromString('123456789012345678901234567890');
    expect(fromCassandra(huge)).toEqual({ kind: 'bigint', text: '123456789012345678901234567890' });
    expect(fromCassandra(Integer.fromNumber(7))).toBe(7);
  });

  it('keeps a decimal as its text', () => {
    expect(fromCassandra(BigDecimal.fromString('1.10'))).toEqual({ kind: 'decimal', text: '1.10' });
    expect(fromCassandra(BigDecimal.fromString('-0.000123'))).toEqual({
      kind: 'decimal',
      text: '-0.000123',
    });
  });

  it('shows a timestamp as ISO text, and an impossible one as such', () => {
    expect(fromCassandra(new Date('2024-02-29T12:30:45.123Z'))).toEqual({
      kind: 'datetime',
      text: '2024-02-29T12:30:45.123Z',
    });
    expect(fromCassandra(new Date(Number.NaN))).toEqual({ kind: 'datetime', text: 'Invalid Date' });
  });

  it('shows dates and times in the server spelling', () => {
    expect(fromCassandra(new LocalDate(2024, 1, 31))).toEqual({
      kind: 'datetime',
      text: '2024-01-31',
    });
    expect(fromCassandra(LocalTime.fromString('13:14:15.123456789'))).toEqual({
      kind: 'datetime',
      text: '13:14:15.123456789',
    });
  });

  it('shows uuids, addresses and durations as text', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(fromCassandra(Uuid.fromString(id))).toBe(id);
    const time = TimeUuid.fromDate(new Date(0));
    expect(fromCassandra(time)).toBe(time.toString());
    expect(fromCassandra(InetAddress.fromString('10.0.0.7'))).toBe('10.0.0.7');
    expect(fromCassandra(InetAddress.fromString('::1'))).toBe('::1');
    expect(fromCassandra(Duration.fromString('1h30m'))).toBe(
      Duration.fromString('1h30m').toString(),
    );
  });

  it('keeps blobs as bytes with a short hex preview', () => {
    expect(fromCassandra(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toMatchObject({
      kind: 'binary',
      size: 4,
      preview: 'deadbeef',
    });
    expect(fromCassandra(new Uint8Array([1, 2]))).toMatchObject({ kind: 'binary', size: 2 });
  });

  it('turns collections, tuples and user-defined types into JSON text', () => {
    expect(fromCassandra([1, 2, 3])).toEqual({ kind: 'json', text: '[1,2,3]' });
    expect(fromCassandra({ a: 1, b: 'x' })).toEqual({ kind: 'json', text: '{"a":1,"b":"x"}' });
    expect(fromCassandra(new Tuple('x', 7))).toEqual({ kind: 'json', text: '["x",7]' });
    expect(fromCassandra(new Set(['a', 'b']))).toEqual({ kind: 'json', text: '["a","b"]' });
    expect(fromCassandra(new Map([[1, 'one']]))).toEqual({ kind: 'json', text: '{"1":"one"}' });
  });
});

describe('jsonText', () => {
  it('writes big integers and decimals in full, unquoted', () => {
    expect(jsonText([Long.fromString('9223372036854775807'), BigDecimal.fromString('1.50')])).toBe(
      '[9223372036854775807,1.50]',
    );
    expect(jsonText(Integer.fromString('99999999999999999999'))).toBe('99999999999999999999');
  });

  it('quotes what is not JSON: ids, addresses, dates, bytes, non-finite numbers', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(jsonText(Uuid.fromString(id))).toBe(`"${id}"`);
    expect(jsonText(InetAddress.fromString('127.0.0.1'))).toBe('"127.0.0.1"');
    expect(jsonText(new LocalDate(2020, 5, 17))).toBe('"2020-05-17"');
    expect(jsonText(new Date('2020-01-01T00:00:00Z'))).toBe('"2020-01-01T00:00:00.000Z"');
    expect(jsonText(Buffer.from([1, 255]))).toBe('"0x01ff"');
    expect(jsonText(Number.POSITIVE_INFINITY)).toBe('"Infinity"');
    expect(jsonText(Number.NaN)).toBe('"NaN"');
  });

  it('nests: a map of lists of user-defined values, with nulls', () => {
    expect(jsonText({ k: [null, { x: true }], 'a"b': 'c' })).toBe(
      '{"k":[null,{"x":true}],"a\\"b":"c"}',
    );
    expect(jsonText(new Float32Array([0.5, 2]))).toBe('[0.5,2]');
    expect(jsonText(undefined)).toBe('null');
    expect(jsonText(12n)).toBe('12');
  });

  it('falls back to the text of anything else', () => {
    expect(jsonText(Symbol('s'))).toBe('"Symbol(s)"');
  });
});

describe('typeName', () => {
  const code = types.dataTypes;

  it('names plain types', () => {
    expect(typeName({ code: code.int })).toBe('int');
    expect(typeName({ code: code.varchar })).toBe('text');
    expect(typeName({ code: code.list, info: { code: code.varchar } })).toBe('list<text>');
    expect(typeName({ code: code.uuid })).toBe('uuid');
  });

  it('names collections with their element types', () => {
    expect(typeName({ code: code.list, info: { code: code.int } })).toBe('list<int>');
    expect(typeName({ code: code.map, info: [{ code: code.text }, { code: code.bigint }] })).toBe(
      'map<text, bigint>',
    );
    expect(typeName({ code: code.tuple, info: [{ code: code.int }, { code: code.text }] })).toBe(
      'tuple<int, text>',
    );
    expect(typeName({ code: code.set, info: { code: code.uuid } })).toBe('set<uuid>');
  });

  it('names a user-defined type by its own name', () => {
    expect(typeName({ code: code.udt, info: { name: 'address', fields: [] } })).toBe('address');
    expect(typeName({ code: code.udt, info: { fields: [] } })).toBe('udt');
  });

  it('says nothing about what is not a type', () => {
    expect(typeName(undefined)).toBeUndefined();
    expect(typeName({})).toBeUndefined();
    expect(typeName('int')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  Binary,
  BSON,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from 'mongodb';
import {
  doc,
  int32,
  int64,
  type MongoDocument,
  sameValue,
  str,
} from '../../../../src/core/mongo/value';
import { readBson } from '../../../../src/drivers/mongodb/bson-read';
import {
  fromDriverDocument,
  fromDriverValue,
  toDriverCommand,
  toDriverDocument,
  toDriverValue,
} from '../../../../src/drivers/mongodb/bson-write';

const OID = '65a1b2c3d4e5f60718293a4b';

/** Every BSON type, the way a document of the seed holds them. */
const EVERY_TYPE: MongoDocument = doc([
  ['_id', { type: 'objectId', value: OID }],
  ['12', str('numeric name stays second')],
  ['double', { type: 'double', value: '1.5' }],
  ['whole', { type: 'double', value: '2' }],
  ['negZero', { type: 'double', value: '-0' }],
  ['nan', { type: 'double', value: 'NaN' }],
  ['inf', { type: 'double', value: '-Infinity' }],
  ['int32', int32(-42)],
  ['int64', int64('-9223372036854775808')],
  ['decimal', { type: 'decimal', value: '1234567890.123456789012345678' }],
  ['string', str('héllo "world"\n✓')],
  ['bool', { type: 'bool', value: true }],
  ['null', { type: 'null' }],
  ['date', { type: 'date', value: '1793277296789' }],
  ['dateOld', { type: 'date', value: '-62198755200000' }],
  ['binary', { type: 'binary', subtype: 0, value: 'AAEC/w==' }],
  ['uuid', { type: 'binary', subtype: 4, value: 'OyQRAeK7QlWMr0E2xWapYg==' }],
  ['regex', { type: 'regex', pattern: 'ab\\/c+', flags: 'i' }],
  ['timestamp', { type: 'timestamp', t: 4_294_967_295, i: 7 }],
  ['minKey', { type: 'minKey' }],
  ['maxKey', { type: 'maxKey' }],
  ['code', { type: 'code', value: 'function () { return 1; }' }],
  ['codeScope', { type: 'code', value: 'x', scope: doc([['x', int32(1)]]) }],
  ['symbol', { type: 'symbol', value: 'sym' }],
  [
    'array',
    {
      type: 'array',
      items: [int32(1), str('two'), { type: 'array', items: [] }, doc([['four', int32(4)]])],
    },
  ],
  ['nested', doc([['a', doc([['b', str('deep')]])]])],
]);

function bytesOf(document: MongoDocument): Uint8Array {
  return BSON.serialize(toDriverDocument(document));
}

describe('readBson (V7.5)', () => {
  it('reads every type back to what was written, field order included', () => {
    expect(sameValue(readBson(bytesOf(EVERY_TYPE)), EVERY_TYPE)).toBe(true);
  });

  it('keeps a numeric field name where the bytes put it, unlike a JavaScript object', () => {
    const bytes = bytesOf(
      doc([
        ['b', int32(1)],
        ['12', int32(2)],
        ['a', int32(3)],
      ]),
    );
    expect(readBson(bytes).fields.map(([name]) => name)).toEqual(['b', '12', 'a']);
    expect(Object.keys(BSON.deserialize(bytes))).toEqual(['12', 'b', 'a']);
  });

  it('reads the old binary subtype without its inner length', () => {
    const bytes = BSON.serialize({ old: new Binary(Buffer.from([1, 2, 3]), 2) });
    expect(readBson(bytes)).toEqual(doc([['old', { type: 'binary', subtype: 2, value: 'AQID' }]]));
  });

  it('reads the deprecated pointer and undefined types', () => {
    // Hand-made: the bson library no longer writes them.
    const name = Buffer.from('p\u0000');
    const ns = Buffer.from('db.c\u0000');
    const pointer = Buffer.concat([
      Buffer.from([0x0c]),
      name,
      Buffer.from([ns.length, 0, 0, 0]),
      ns,
      Buffer.from(OID, 'hex'),
      Buffer.from([0x06]),
      Buffer.from('u\u0000'),
    ]);
    const bytes = Buffer.concat([Buffer.alloc(4), pointer, Buffer.from([0])]);
    bytes.writeInt32LE(bytes.length, 0);
    expect(readBson(bytes)).toEqual(
      doc([
        ['p', { type: 'dbPointer', ns: 'db.c', id: OID }],
        ['u', { type: 'undefined' }],
      ]),
    );
  });

  it.each([
    ['too short', Buffer.from([4, 0, 0, 0])],
    ['a size past the end', Buffer.from([50, 0, 0, 0, 0])],
    ['no closing zero', Buffer.from([5, 0, 0, 0, 1])],
    ['an unknown type', Buffer.from([8, 0, 0, 0, 0x20, 0x61, 0, 0])],
    ['bytes after it', Buffer.from([5, 0, 0, 0, 0, 0])],
    ['a value past its document', Buffer.from([9, 0, 0, 0, 0x10, 0x61, 0, 1, 0])],
  ])('refuses a document with %s', (_why, bytes) => {
    expect(() => readBson(bytes)).toThrow('The server sent a document DataNest cannot read');
  });

  it('refuses a string whose length does not end in its zero', () => {
    const bytes = Buffer.from(bytesOf(doc([['s', str('abc')]])));
    bytes.writeInt32LE(2, 7);
    expect(() => readBson(bytes)).toThrow('a string has a wrong size');
  });
});

describe('toDriverValue (V7.5)', () => {
  it('turns each type into the class the driver writes', () => {
    const values = toDriverDocument(EVERY_TYPE);
    expect(values.get('_id')).toBeInstanceOf(ObjectId);
    expect(values.get('double')).toBeInstanceOf(Double);
    expect(values.get('int32')).toBeInstanceOf(Int32);
    expect(values.get('int64')).toBeInstanceOf(Long);
    expect(values.get('decimal')).toBeInstanceOf(Decimal128);
    expect(values.get('date')).toBeInstanceOf(Date);
    expect(values.get('binary')).toBeInstanceOf(Binary);
    expect(values.get('regex')).toBeInstanceOf(BSONRegExp);
    expect(values.get('timestamp')).toBeInstanceOf(Timestamp);
    expect(values.get('minKey')).toBeInstanceOf(MinKey);
    expect(values.get('maxKey')).toBeInstanceOf(MaxKey);
    expect(values.get('code')).toBeInstanceOf(Code);
    expect(values.get('symbol')).toBeInstanceOf(BSONSymbol);
    expect(values.get('nested')).toBeInstanceOf(Map);
    expect([...values.keys()].slice(0, 2)).toEqual(['_id', '12']);
  });

  it('writes undefined as null and a pointer as a DBRef', () => {
    expect(toDriverValue({ type: 'undefined' })).toBeNull();
    expect(toDriverValue({ type: 'dbPointer', ns: 'db.c', id: OID })).toBeInstanceOf(DBRef);
  });

  it('refuses a date a JavaScript Date cannot hold', () => {
    expect(() => toDriverValue({ type: 'date', value: '9000000000000000' })).toThrow(
      'out of the range',
    );
    expect(() => toDriverValue({ type: 'date', value: '1.5' })).toThrow('out of the range');
  });

  it('keeps the command name first and the documents in it as Maps', () => {
    const command = toDriverCommand(
      doc([
        ['insert', str('orders')],
        [
          'documents',
          {
            type: 'array',
            items: [
              doc([
                ['12', int32(1)],
                ['a', int32(2)],
              ]),
            ],
          },
        ],
      ]),
    );
    expect(Object.keys(command)).toEqual(['insert', 'documents']);
    const [first] = command.documents as Map<string, unknown>[];
    expect([...(first?.keys() ?? [])]).toEqual(['12', 'a']);
  });
});

describe('fromDriverValue (V7.5)', () => {
  it('reads the classes a reply holds with promoteValues: false', () => {
    expect(fromDriverValue(new Int32(5))).toEqual(int32(5));
    expect(fromDriverValue(new Double(5))).toEqual({ type: 'double', value: '5' });
    expect(fromDriverValue(Long.fromString('9223372036854775807'))).toEqual(
      int64('9223372036854775807'),
    );
    expect(fromDriverValue(Decimal128.fromString('1.10'))).toEqual({
      type: 'decimal',
      value: '1.10',
    });
    expect(fromDriverValue(ObjectId.createFromHexString(OID))).toEqual({
      type: 'objectId',
      value: OID,
    });
    expect(fromDriverValue(new Binary(Buffer.from([1]), 3))).toEqual({
      type: 'binary',
      subtype: 3,
      value: 'AQ==',
    });
    expect(fromDriverValue(new BSONRegExp('a', 'i'))).toEqual({
      type: 'regex',
      pattern: 'a',
      flags: 'i',
    });
    expect(fromDriverValue(new Timestamp({ t: 3, i: 4 }))).toEqual({
      type: 'timestamp',
      t: 3,
      i: 4,
    });
    expect(fromDriverValue(new MinKey())).toEqual({ type: 'minKey' });
    expect(fromDriverValue(new MaxKey())).toEqual({ type: 'maxKey' });
    expect(fromDriverValue(new Code('x', { a: 1 }))).toEqual({
      type: 'code',
      value: 'x',
      scope: doc([['a', int32(1)]]),
    });
    expect(fromDriverValue(new Code('x'))).toEqual({ type: 'code', value: 'x' });
    expect(fromDriverValue(new BSONSymbol('s'))).toEqual({ type: 'symbol', value: 's' });
    expect(fromDriverValue(new DBRef('users', ObjectId.createFromHexString(OID), 'app'))).toEqual(
      doc([
        ['$ref', str('users')],
        ['$id', { type: 'objectId', value: OID }],
        ['$db', str('app')],
      ]),
    );
  });

  it('reads plain JavaScript values', () => {
    expect(fromDriverValue(null)).toEqual({ type: 'null' });
    expect(fromDriverValue(undefined)).toEqual({ type: 'undefined' });
    expect(fromDriverValue(true)).toEqual({ type: 'bool', value: true });
    expect(fromDriverValue(7)).toEqual(int32(7));
    expect(fromDriverValue(2 ** 40)).toEqual({ type: 'double', value: '1099511627776' });
    expect(fromDriverValue(-0)).toEqual({ type: 'double', value: '-0' });
    expect(fromDriverValue(1.5)).toEqual({ type: 'double', value: '1.5' });
    expect(fromDriverValue(5n)).toEqual(int64('5'));
    expect(fromDriverValue(new Date(0))).toEqual({ type: 'date', value: '0' });
    expect(fromDriverValue(/x/g)).toEqual({ type: 'regex', pattern: 'x', flags: 'g' });
    expect(fromDriverValue(new Uint8Array([255]))).toEqual({
      type: 'binary',
      subtype: 0,
      value: '/w==',
    });
    expect(fromDriverValue(['a'])).toEqual({ type: 'array', items: [str('a')] });
    expect(fromDriverValue(new Map([['b', 1]]))).toEqual(doc([['b', int32(1)]]));
    expect(fromDriverDocument({ ok: 1 })).toEqual(doc([['ok', int32(1)]]));
  });

  it('refuses a reply nested past 200 levels', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 300; level += 1) {
      deep = [deep];
    }
    expect(() => fromDriverValue(deep)).toThrow('nests too deeply');
  });
});

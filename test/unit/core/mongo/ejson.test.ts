import { describe, expect, it } from 'vitest';
import { formatJsonLine, parseJson } from '../../../../src/core/json/json-tree';
import {
  EjsonError,
  fromEjson,
  fromEjsonDocument,
  toEjson,
} from '../../../../src/core/mongo/ejson';
import type { MongoDocument, MongoValue } from '../../../../src/core/mongo/value';

const EVERY_TYPE: MongoDocument = {
  type: 'document',
  fields: [
    ['_id', { type: 'objectId', value: '507f1f77bcf86cd799439011' }],
    ['n32', { type: 'int32', value: -7 }],
    ['n64', { type: 'int64', value: '9007199254740993' }],
    ['d', { type: 'double', value: '1.5' }],
    ['nan', { type: 'double', value: 'NaN' }],
    ['inf', { type: 'double', value: '-Infinity' }],
    ['dec', { type: 'decimal', value: '1.10' }],
    ['s', { type: 'string', value: 'текст "q"' }],
    ['b', { type: 'bool', value: true }],
    ['nil', { type: 'null' }],
    ['undef', { type: 'undefined' }],
    ['at', { type: 'date', value: '1700000000123' }],
    ['bin', { type: 'binary', subtype: 4, value: 'AAECAwQFBgcICQoLDA0ODw==' }],
    ['re', { type: 'regex', pattern: '^a.*', flags: 'i' }],
    ['ts', { type: 'timestamp', t: 1700000000, i: 3 }],
    ['min', { type: 'minKey' }],
    ['max', { type: 'maxKey' }],
    [
      'code',
      {
        type: 'code',
        value: 'function () {}',
        scope: { type: 'document', fields: [['x', { type: 'int32', value: 1 }]] },
      },
    ],
    ['sym', { type: 'symbol', value: 'old' }],
    ['ptr', { type: 'dbPointer', ns: 'db.c', id: '507f1f77bcf86cd799439012' }],
    [
      'list',
      {
        type: 'array',
        items: [
          { type: 'int32', value: 1 },
          { type: 'string', value: 'two' },
        ],
      },
    ],
    ['12', { type: 'document', fields: [['nested', { type: 'bool', value: false }]] }],
  ],
};

function roundTrip(value: MongoValue): MongoValue {
  return fromEjson(parseJson(formatJsonLine(toEjson(value))));
}

describe('toEjson and fromEjson', () => {
  it('bring every BSON type back as it was, fields in their order', () => {
    expect(roundTrip(EVERY_TYPE)).toEqual(EVERY_TYPE);
  });

  it('write canonical Extended JSON', () => {
    const line = formatJsonLine(toEjson(EVERY_TYPE));
    expect(line).toContain('"_id":{"$oid":"507f1f77bcf86cd799439011"}');
    expect(line).toContain('"n32":{"$numberInt":"-7"}');
    expect(line).toContain('"n64":{"$numberLong":"9007199254740993"}');
    expect(line).toContain('"nan":{"$numberDouble":"NaN"}');
    expect(line).toContain('"at":{"$date":{"$numberLong":"1700000000123"}}');
    expect(line).toContain(
      '"bin":{"$binary":{"base64":"AAECAwQFBgcICQoLDA0ODw==","subType":"04"}}',
    );
    expect(line).toContain('"re":{"$regularExpression":{"pattern":"^a.*","options":"i"}}');
    expect(line).toContain('"ts":{"$timestamp":{"t":1700000000,"i":3}}');
    expect(line.indexOf('"12"')).toBeGreaterThan(line.indexOf('"list"'));
  });
});

describe('fromEjson in relaxed mode, as mongoexport writes', () => {
  const read = (text: string): MongoValue => fromEjson(parseJson(text));

  it('reads plain numbers as int32, int64 or double by their size and form', () => {
    expect(read('42')).toEqual({ type: 'int32', value: 42 });
    expect(read('2147483647')).toEqual({ type: 'int32', value: 2147483647 });
    expect(read('2147483648')).toEqual({ type: 'int64', value: '2147483648' });
    expect(read('-9223372036854775808')).toEqual({ type: 'int64', value: '-9223372036854775808' });
    expect(read('9223372036854775808')).toEqual({ type: 'double', value: '9223372036854776000' });
    expect(read('1.5')).toEqual({ type: 'double', value: '1.5' });
    expect(read('1e3')).toEqual({ type: 'double', value: '1000' });
    expect(read('-0.0')).toEqual({ type: 'double', value: '-0' });
  });

  it('reads dates written as text or as a number', () => {
    expect(read('{"$date":"2024-01-02T03:04:05.006Z"}')).toEqual({
      type: 'date',
      value: '1704164645006',
    });
    expect(read('{"$date":1704164645006}')).toEqual({ type: 'date', value: '1704164645006' });
  });

  it('reads the older shapes of binary and regular expressions', () => {
    expect(read('{"$binary":"AAE=","$type":"00"}')).toEqual({
      type: 'binary',
      subtype: 0,
      value: 'AAE=',
    });
    expect(read('{"$regex":"^x","$options":"m"}')).toEqual({
      type: 'regex',
      pattern: '^x',
      flags: 'm',
    });
    expect(read('{"$regex":"^x"}')).toEqual({ type: 'regex', pattern: '^x', flags: '' });
  });

  it('keeps a document whose field merely starts with $ a document', () => {
    expect(read('{"$match":{"a":1}}')).toEqual({
      type: 'document',
      fields: [['$match', { type: 'document', fields: [['a', { type: 'int32', value: 1 }]] }]],
    });
    expect(read('{"$date":1,"other":2}')).toMatchObject({ type: 'document' });
  });

  it('takes an ObjectId written in upper case and keeps it in lower case', () => {
    expect(read('{"$oid":"507F1F77BCF86CD799439011"}')).toEqual({
      type: 'objectId',
      value: '507f1f77bcf86cd799439011',
    });
  });
});

describe('fromEjson refusals', () => {
  it.each([
    ['{"$oid":"nope"}', /not an ObjectId/u],
    ['{"$oid":1}', /must be text/u],
    ['{"$numberInt":"3000000000"}', /32-bit/u],
    ['{"$numberInt":"1.5"}', /whole number/u],
    ['{"$numberLong":"x"}', /whole number/u],
    ['{"$numberDouble":"abc"}', /not a number/u],
    ['{"$date":"yesterday"}', /not a date/u],
    ['{"$date":true}', /must be a date/u],
    ['{"$binary":{"base64":"AA==","subType":"zz"}}', /binary subtype/u],
    ['{"$code":"f","$scope":1}', /must be a document/u],
    ['{"$dbPointer":{"$ref":"c","$id":1}}', /needs an ObjectId/u],
  ])('refuses %s', (text, reason) => {
    expect(() => fromEjson(parseJson(text))).toThrow(reason);
  });

  it('wants a document on each line', () => {
    expect(() => fromEjsonDocument(parseJson('[1]'))).toThrow(EjsonError);
    expect(() => fromEjsonDocument(parseJson('"text"'))).toThrow(/not string/u);
    expect(fromEjsonDocument(parseJson('{}'))).toEqual({ type: 'document', fields: [] });
  });
});

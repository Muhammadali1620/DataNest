import { describe, expect, it } from 'vitest';
import {
  arrayField,
  bool,
  boolField,
  doc,
  documentField,
  double,
  field,
  int32,
  int64,
  type MongoValue,
  NULL,
  numberField,
  sameValue,
  str,
  stringField,
  toNumber,
} from '../../../../src/core/mongo/value';

describe('MongoValue helpers (V7.5)', () => {
  const reply = doc([
    ['ok', double(1)],
    ['n', int32(3)],
    ['name', str('orders')],
    ['nested', doc([['a', int32(1)]])],
    ['list', { type: 'array', items: [int32(1)] }],
    ['flag', bool(false)],
    ['long', int64('12')],
  ]);

  it('reads fields by name and type', () => {
    expect(field(reply, 'n')).toEqual(int32(3));
    expect(field(reply, 'missing')).toBeUndefined();
    expect(stringField(reply, 'name')).toBe('orders');
    expect(stringField(reply, 'n')).toBeUndefined();
    expect(numberField(reply, 'long')).toBe(12);
    expect(numberField(reply, 'name')).toBeUndefined();
    expect(documentField(reply, 'nested')).toEqual(doc([['a', int32(1)]]));
    expect(documentField(reply, 'list')).toBeUndefined();
    expect(arrayField(reply, 'list')).toEqual([int32(1)]);
    expect(arrayField(reply, 'nested')).toBeUndefined();
  });

  it('reads numbers as booleans the way the server does (ok: 1)', () => {
    expect(boolField(reply, 'ok')).toBe(true);
    expect(boolField(reply, 'flag')).toBe(false);
    expect(boolField(doc([['ok', int32(0)]]), 'ok')).toBe(false);
    expect(boolField(reply, 'name')).toBeUndefined();
  });

  it('turns every numeric type into a number, and nothing else', () => {
    expect(toNumber(int32(5))).toBe(5);
    expect(toNumber(int64('9007199254740993'))).toBe(9_007_199_254_740_992);
    expect(toNumber(double(1.5))).toBe(1.5);
    expect(toNumber({ type: 'double', value: 'NaN' })).toBeNaN();
    expect(toNumber({ type: 'decimal', value: '2.5' })).toBe(2.5);
    expect(toNumber({ type: 'decimal', value: 'nonsense' })).toBeUndefined();
    expect(toNumber(str('5'))).toBeUndefined();
  });

  it('keeps the sign of a negative zero double', () => {
    expect(double(-0)).toEqual({ type: 'double', value: '-0' });
    expect(NULL).toEqual({ type: 'null' });
  });

  it('compares values by type, content and field order', () => {
    const samples: MongoValue[] = [
      NULL,
      { type: 'undefined' },
      { type: 'minKey' },
      { type: 'maxKey' },
      bool(true),
      int32(1),
      int64('1'),
      double(1),
      { type: 'decimal', value: '1' },
      str('1'),
      { type: 'objectId', value: '65a1b2c3d4e5f60718293a4b' },
      { type: 'date', value: '1' },
      { type: 'symbol', value: '1' },
      { type: 'binary', subtype: 0, value: 'AA==' },
      { type: 'binary', subtype: 1, value: 'AA==' },
      { type: 'regex', pattern: 'a', flags: '' },
      { type: 'regex', pattern: 'a', flags: 'i' },
      { type: 'timestamp', t: 1, i: 2 },
      { type: 'timestamp', t: 2, i: 1 },
      { type: 'code', value: 'x' },
      { type: 'code', value: 'x', scope: doc([]) },
      { type: 'dbPointer', ns: 'a.b', id: '65a1b2c3d4e5f60718293a4b' },
      { type: 'array', items: [int32(1)] },
      { type: 'array', items: [int32(1), int32(2)] },
      doc([
        ['a', int32(1)],
        ['b', int32(2)],
      ]),
      doc([
        ['b', int32(2)],
        ['a', int32(1)],
      ]),
    ];
    for (const [index, a] of samples.entries()) {
      for (const [other, b] of samples.entries()) {
        expect(sameValue(a, b)).toBe(index === other);
      }
      expect(sameValue(a, structuredClone(a))).toBe(true);
    }
  });
});

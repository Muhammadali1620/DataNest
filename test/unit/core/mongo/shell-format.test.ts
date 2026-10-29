import { describe, expect, it } from 'vitest';
import {
  base64ToHex,
  formatDouble,
  formatName,
  formatPretty,
  formatValue,
  hexToBase64,
  isoDate,
  previewValue,
  uuidText,
} from '../../../../src/core/mongo/shell-format';
import { doc, double, int32, int64, type MongoValue, str } from '../../../../src/core/mongo/value';

describe('formatValue (V7.5)', () => {
  it.each<[MongoValue, string]>([
    [{ type: 'null' }, 'null'],
    [{ type: 'undefined' }, 'undefined'],
    [{ type: 'bool', value: false }, 'false'],
    [int32(42), '42'],
    [int32(-7), '-7'],
    [int64('9223372036854775807'), 'NumberLong("9223372036854775807")'],
    [double(1.5), '1.5'],
    [double(2), '2.0'],
    [double(-0), '-0.0'],
    [{ type: 'double', value: 'NaN' }, 'NaN'],
    [{ type: 'double', value: 'Infinity' }, 'Infinity'],
    [{ type: 'double', value: '-Infinity' }, '-Infinity'],
    [{ type: 'double', value: '1e+21' }, '1e+21'],
    [{ type: 'decimal', value: '12.50' }, 'NumberDecimal("12.50")'],
    [str('a "b"\n'), '"a \\"b\\"\\n"'],
    [
      { type: 'objectId', value: '65a1b2c3d4e5f60718293a4b' },
      'ObjectId("65a1b2c3d4e5f60718293a4b")',
    ],
    [{ type: 'date', value: '0' }, 'ISODate("1970-01-01T00:00:00.000Z")'],
    [{ type: 'date', value: '-62198755200000' }, 'new Date(-62198755200000)'],
    [{ type: 'date', value: '9999999999999999999' }, 'new Date(9999999999999999999)'],
    [{ type: 'binary', subtype: 0, value: 'AAEC/w==' }, 'BinData(0, "AAEC/w==")'],
    [
      { type: 'binary', subtype: 4, value: 'OyQRAeK7QlWMr0E2xWapYg==' },
      'UUID("3b241101-e2bb-4255-8caf-4136c566a962")',
    ],
    [{ type: 'binary', subtype: 4, value: 'AAE=' }, 'BinData(4, "AAE=")'],
    [{ type: 'regex', pattern: 'ab\\/c+', flags: 'i' }, '/ab\\/c+/i'],
    [{ type: 'regex', pattern: 'a/b', flags: '' }, '/a\\/b/'],
    [{ type: 'regex', pattern: '[/]', flags: 'm' }, '/[/]/m'],
    [{ type: 'regex', pattern: '', flags: 'i' }, 'RegExp("", "i")'],
    [{ type: 'regex', pattern: 'a\nb', flags: '' }, 'RegExp("a\\nb", "")'],
    [{ type: 'timestamp', t: 1_700_000_000, i: 7 }, 'Timestamp(1700000000, 7)'],
    [{ type: 'minKey' }, 'MinKey()'],
    [{ type: 'maxKey' }, 'MaxKey()'],
    [{ type: 'code', value: 'return 1' }, 'Code("return 1")'],
    [{ type: 'code', value: 'x', scope: doc([['x', int32(1)]]) }, 'Code("x", { x: 1 })'],
    [{ type: 'symbol', value: 's' }, 'Symbol("s")'],
    [
      { type: 'dbPointer', ns: 'db.c', id: '65a1b2c3d4e5f60718293a4b' },
      'DBPointer("db.c", ObjectId("65a1b2c3d4e5f60718293a4b"))',
    ],
    [{ type: 'array', items: [] }, '[]'],
    [{ type: 'array', items: [int32(1), str('two')] }, '[1, "two"]'],
    [doc([]), '{}'],
    [
      doc([
        ['a', int32(1)],
        ['b c', doc([])],
      ]),
      '{ a: 1, "b c": {} }',
    ],
  ])('writes %j as %s', (value, text) => {
    expect(formatValue(value)).toBe(text);
  });

  it('quotes names that are not identifiers, and keeps $ and _ bare', () => {
    expect(formatName('email')).toBe('email');
    expect(formatName('$set')).toBe('$set');
    expect(formatName('_id')).toBe('_id');
    expect(formatName('12')).toBe('"12"');
    expect(formatName('dotted.name')).toBe('"dotted.name"');
    expect(formatName('')).toBe('""');
    expect(formatName('ключ')).toBe('"ключ"');
  });

  it('marks every double as one, so it is read back as a double', () => {
    expect(formatDouble('3')).toBe('3.0');
    expect(formatDouble('3.25')).toBe('3.25');
    expect(formatDouble('-1e-7')).toBe('-1e-7');
  });
});

describe('formatPretty (V7.5)', () => {
  it('lays documents out over lines, two spaces a level', () => {
    const value = doc([
      ['_id', int32(1)],
      ['nested', doc([['a', doc([['b', str('c')]])]])],
      ['empty', doc([])],
    ]);
    expect(formatPretty(value)).toBe(
      '{\n  _id: 1,\n  nested: {\n    a: {\n      b: "c"\n    }\n  },\n  empty: {}\n}',
    );
  });

  it('keeps a short array of plain values on one line', () => {
    expect(formatPretty(doc([['tags', { type: 'array', items: [str('a'), str('b')] }]]))).toBe(
      '{\n  tags: ["a", "b"]\n}',
    );
  });

  it('breaks an array of documents, or a long one, over lines', () => {
    const items = { type: 'array' as const, items: [doc([['x', int32(1)]])] };
    expect(formatPretty(items)).toBe('[\n  {\n    x: 1\n  }\n]');
    const long = {
      type: 'array' as const,
      items: Array.from({ length: 30 }, (_, index) => int32(index)),
    };
    expect(formatPretty(long).split('\n')).toHaveLength(32);
  });
});

describe('dates, UUIDs and base64', () => {
  it('writes years 0–9999 as ISO text, and only those', () => {
    expect(isoDate('1793282421000')).toBe('2026-10-29T14:00:21.000Z');
    expect(isoDate('-62167219200000')).toBe('0000-01-01T00:00:00.000Z');
    expect(isoDate('253402300800000')).toBeUndefined();
    expect(isoDate('8640000000000001')).toBeUndefined();
    expect(isoDate('abc')).toBeUndefined();
  });

  it('reads a UUID only from 16 bytes of subtype 4', () => {
    expect(uuidText({ subtype: 3, value: 'OyQRAeK7QlWMr0E2xWapYg==' })).toBeUndefined();
    expect(uuidText({ subtype: 4, value: '!!' })).toBeUndefined();
  });

  it('turns base64 into hex and back', () => {
    for (const hex of ['', '00', 'ff00', '000102ff', '0123456789abcdef', 'deadbeefcafe01']) {
      expect(base64ToHex(hexToBase64(hex))).toBe(hex);
      expect(hexToBase64(hex)).toBe(Buffer.from(hex, 'hex').toString('base64'));
    }
    expect(base64ToHex('A')).toBeUndefined();
    expect(base64ToHex('ab$c')).toBeUndefined();
  });
});

describe('previewValue (V7.5)', () => {
  it('shows a string as it is, on one line', () => {
    expect(previewValue(str('a\nb'), 20)).toBe('a b');
  });

  it('cuts long values with an ellipsis, never inside a surrogate pair', () => {
    expect(previewValue(str('abcdef'), 4)).toBe('abc…');
    expect(previewValue(str('ab😀cd'), 4)).toBe('ab…');
    expect(previewValue(doc([['a', str('x'.repeat(50))]]), 10)).toHaveLength(10);
  });

  it('writes other values in the shell syntax', () => {
    expect(previewValue(int64('5'), 50)).toBe('NumberLong("5")');
  });
});

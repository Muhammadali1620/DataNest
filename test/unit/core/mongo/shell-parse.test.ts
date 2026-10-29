import { describe, expect, it } from 'vitest';
import { formatPretty, formatValue } from '../../../../src/core/mongo/shell-format';
import {
  lineAndColumn,
  parseDocument,
  parsePipeline,
  parseValue,
  ShellSyntaxError,
} from '../../../../src/core/mongo/shell-parse';
import { ShellReader } from '../../../../src/core/mongo/shell-reader';
import {
  doc,
  int32,
  int64,
  type MongoValue,
  sameValue,
  str,
} from '../../../../src/core/mongo/value';

function errorOf(text: string): ShellSyntaxError {
  try {
    parseValue(text);
  } catch (error) {
    if (error instanceof ShellSyntaxError) {
      return error;
    }
    throw error;
  }
  throw new Error(`"${text}" parsed`);
}

describe('parseValue: plain values (V7.5)', () => {
  it.each<[string, MongoValue]>([
    ['null', { type: 'null' }],
    ['undefined', { type: 'undefined' }],
    ['true', { type: 'bool', value: true }],
    ['false', { type: 'bool', value: false }],
    ['0', int32(0)],
    ['-0', int32(0)],
    ['42', int32(42)],
    ['+42', int32(42)],
    ['2147483647', int32(2_147_483_647)],
    ['-2147483648', int32(-2_147_483_648)],
    ['2147483648', int64('2147483648')],
    ['9223372036854775807', int64('9223372036854775807')],
    ['-9223372036854775808', int64('-9223372036854775808')],
    ['0x1F', int32(31)],
    ['-0x10', int32(-16)],
    ['1.5', { type: 'double', value: '1.5' }],
    ['2.0', { type: 'double', value: '2' }],
    ['-0.0', { type: 'double', value: '-0' }],
    ['.5', { type: 'double', value: '0.5' }],
    ['5.', { type: 'double', value: '5' }],
    ['1e3', { type: 'double', value: '1000' }],
    ['1E-2', { type: 'double', value: '0.01' }],
    ['NaN', { type: 'double', value: 'NaN' }],
    ['Infinity', { type: 'double', value: 'Infinity' }],
    ['-Infinity', { type: 'double', value: '-Infinity' }],
    ['"a"', str('a')],
    ["'a'", str('a')],
    ['`a`', str('a')],
    ['"\\n\\t\\r\\b\\f\\v\\0\\\\\\"\\/"', str('\n\t\r\b\f\v\0\\"/')],
    ['"\\x41\\u0042\\u{1F600}"', str('AB😀')],
    ['"a\\\nb"', str('ab')],
    ['`line\nbreak`', str('line\nbreak')],
    ['"ключ ✓"', str('ключ ✓')],
  ])('reads %s', (text, value) => {
    expect(parseValue(text)).toEqual(value);
  });
});

describe('parseValue: documents and arrays (V7.5)', () => {
  it('reads bare, quoted and numeric names, in order', () => {
    expect(parseValue('{ b: 1, "a b": 2, \'c\': 3, 12: 4, $set: 5, _id: 6 }')).toEqual(
      doc([
        ['b', int32(1)],
        ['a b', int32(2)],
        ['c', int32(3)],
        ['12', int32(4)],
        ['$set', int32(5)],
        ['_id', int32(6)],
      ]),
    );
  });

  it('allows trailing commas, comments and line breaks', () => {
    const text = `{
      // the id
      _id: 1, /* a block
      comment */ tags: [1, 2,],
    }`;
    expect(parseValue(text)).toEqual(
      doc([
        ['_id', int32(1)],
        ['tags', { type: 'array', items: [int32(1), int32(2)] }],
      ]),
    );
  });

  it('keeps a name that repeats, as BSON may', () => {
    expect(parseValue('{ a: 1, a: 2 }')).toEqual(
      doc([
        ['a', int32(1)],
        ['a', int32(2)],
      ]),
    );
  });

  it('reads empty documents and arrays', () => {
    expect(parseValue('{}')).toEqual(doc([]));
    expect(parseValue('[ ]')).toEqual({ type: 'array', items: [] });
  });
});

describe('parseValue: constructors (V7.5)', () => {
  it.each<[string, MongoValue]>([
    [
      'ObjectId("65A1B2C3D4E5F60718293A4B")',
      { type: 'objectId', value: '65a1b2c3d4e5f60718293a4b' },
    ],
    ['ISODate("2026-10-29T12:34:56.789Z")', { type: 'date', value: '1793277296789' }],
    ['ISODate("2026-10-29")', { type: 'date', value: '1793232000000' }],
    ['new Date("2026-10-29T00:00:00+03:00")', { type: 'date', value: '1793221200000' }],
    ['Date(0)', { type: 'date', value: '0' }],
    ['new Date(-62198755200000)', { type: 'date', value: '-62198755200000' }],
    ['NumberLong("123")', int64('123')],
    ['NumberLong(123)', int64('123')],
    ['Long("-5")', int64('-5')],
    ['NumberInt(7)', int32(7)],
    ['NumberInt("7")', int32(7)],
    ['Int32(-1)', int32(-1)],
    ['Double(2)', { type: 'double', value: '2' }],
    ['Double("1.25")', { type: 'double', value: '1.25' }],
    ['NumberDecimal("12.50")', { type: 'decimal', value: '12.50' }],
    ['Decimal128("-1E+3")', { type: 'decimal', value: '-1E+3' }],
    ['NumberDecimal("NaN")', { type: 'decimal', value: 'NaN' }],
    ['BinData(0, "AAEC/w==")', { type: 'binary', subtype: 0, value: 'AAEC/w==' }],
    ['HexData(5, "00ff")', { type: 'binary', subtype: 5, value: 'AP8=' }],
    [
      'UUID("3b241101-e2bb-4255-8caf-4136c566a962")',
      { type: 'binary', subtype: 4, value: 'OyQRAeK7QlWMr0E2xWapYg==' },
    ],
    ['Timestamp(1700000000, 7)', { type: 'timestamp', t: 1_700_000_000, i: 7 }],
    ['Timestamp({ t: 1, i: 2 })', { type: 'timestamp', t: 1, i: 2 }],
    ['MinKey()', { type: 'minKey' }],
    ['MinKey', { type: 'minKey' }],
    ['MaxKey', { type: 'maxKey' }],
    ['RegExp("a/b", "mi")', { type: 'regex', pattern: 'a/b', flags: 'im' }],
    ['BSONRegExp("x")', { type: 'regex', pattern: 'x', flags: '' }],
    ['/ab\\/c+/gi', { type: 'regex', pattern: 'ab\\/c+', flags: 'gi' }],
    ['/[/]x/', { type: 'regex', pattern: '[/]x', flags: '' }],
    ['/x/ii', { type: 'regex', pattern: 'x', flags: 'i' }],
    ['Code("return 1")', { type: 'code', value: 'return 1' }],
    ['Code("x", { x: 1 })', { type: 'code', value: 'x', scope: doc([['x', int32(1)]]) }],
    [
      'DBRef("users", 5, "app")',
      doc([
        ['$ref', str('users')],
        ['$id', int32(5)],
        ['$db', str('app')],
      ]),
    ],
  ])('reads %s', (text, value) => {
    expect(parseValue(text)).toEqual(value);
  });

  it('makes a new ObjectId and the current date when called without arguments', () => {
    const id = parseValue('ObjectId()');
    expect(id.type).toBe('objectId');
    expect(id.type === 'objectId' && /^[0-9a-f]{24}$/.test(id.value)).toBe(true);
    const date = parseValue('new Date()');
    expect(date.type === 'date' && Math.abs(Number(date.value) - Date.now()) < 5000).toBe(true);
  });
});

describe('parseValue: errors (V7.5)', () => {
  it.each([
    ['', 'Nothing to read'],
    ['{ a: 1', 'Expected "," or "}"'],
    ['{ a 1 }', 'Expected ":" after the field name'],
    ['[1 2]', 'Expected "," or "]"'],
    ['"open', 'The string is not closed'],
    ['"a\nb"', 'A line break inside a string'],
    ['`${x}`', 'Templates with ${…} are not data'],
    ['"\\01"', 'Octal escapes are not allowed'],
    ['"\\xZZ"', 'A wrong escape'],
    ['"\\u{110000}"', 'A wrong \\u{…} escape'],
    ['/* open', 'The comment is not closed'],
    ['/abc', 'The regular expression is not closed'],
    ['12abc', 'Unexpected "a" in a number'],
    ['99999999999999999999', 'too large for a 64-bit integer'],
    ['eval("x")', 'Unknown constructor eval()'],
    ['process', 'Unknown value "process"'],
    ['new', 'Expected a constructor after "new"'],
    ['ObjectId("abc")', 'ObjectId(): expects 24 hex digits'],
    ['ObjectId(1, 2)', 'ObjectId(): takes 0 to 1 arguments'],
    ['ISODate("yesterday")', 'ISODate(): expects an ISO date'],
    ['NumberLong("1.5")', 'NumberLong(): expects a whole number'],
    ['NumberLong("9223372036854775808")', 'NumberLong(): is out of the 64-bit range'],
    ['NumberInt(3000000000)', 'NumberInt(): expects a whole number within 32 bits'],
    ['NumberDecimal("1,5")', 'NumberDecimal(): expects a decimal number'],
    ['BinData(300, "")', 'BinData(): expects a subtype from 0 to 255'],
    ['BinData(0, "abc")', 'BinData(): expects base64 data'],
    ['HexData(0, "abc")', 'HexData(): expects a subtype and hex digits'],
    ['UUID("123")', 'UUID(): expects 32 hex digits'],
    ['Timestamp(-1, 0)', 'Timestamp(): expects whole numbers t and i'],
    ['RegExp("a", "1")', 'RegExp(): expects letters as flags'],
    ['Code("x", 1)', 'Code(): expects a document as the scope'],
    ['1 2', 'Unexpected text after the value'],
    ['#', 'Unexpected "#"'],
  ])('refuses %j', (text, message) => {
    expect(errorOf(text).message).toContain(message);
  });

  it('says where the problem is', () => {
    const error = errorOf('{\n  a: 1,\n  b: ObjectId("x")\n}');
    expect(lineAndColumn('{\n  a: 1,\n  b: ObjectId("x")\n}', error.offset)).toEqual({
      line: 3,
      column: 6,
    });
  });

  it('refuses a document nested past 200 levels', () => {
    expect(errorOf(`${'['.repeat(300)}${']'.repeat(300)}`).message).toContain('nests too deeply');
  });
});

describe('parseDocument and parsePipeline (V7.5)', () => {
  it('takes blank text as the empty document, unless told not to', () => {
    expect(parseDocument('  ')).toEqual(doc([]));
    expect(() => parseDocument('', 'error')).toThrow(ShellSyntaxError);
  });

  it('wants braces', () => {
    expect(() => parseDocument('[1]')).toThrow('Expected a document');
  });

  it('reads a pipeline of stage documents', () => {
    expect(parsePipeline('[{ $match: { a: 1 } }, { $limit: 5 }]')).toHaveLength(2);
    expect(parsePipeline('')).toEqual([]);
    expect(() => parsePipeline('{ $match: {} }')).toThrow('Expected the stages in brackets');
    expect(() => parsePipeline('[1]')).toThrow('Stage 1 is not a document');
  });
});

describe('the format and the parser agree (V7.5)', () => {
  const corpus: MongoValue[] = [
    doc([
      ['_id', { type: 'objectId', value: '65a1b2c3d4e5f60718293a4b' }],
      ['12', str('numeric name first')],
      ['int', int32(1)],
      ['long', int64('-9223372036854775808')],
      ['whole', { type: 'double', value: '2' }],
      ['negZero', { type: 'double', value: '-0' }],
      ['nan', { type: 'double', value: 'NaN' }],
      ['small', { type: 'double', value: '1e-7' }],
      ['huge', { type: 'double', value: '1.7976931348623157e+308' }],
      ['decimal', { type: 'decimal', value: '0.10' }],
      ['text', str('quote " backslash \\ tab \t line\n emoji 😀  ')],
      ['date', { type: 'date', value: '1793277296789' }],
      ['ancient', { type: 'date', value: '-62198755200000' }],
      ['bin', { type: 'binary', subtype: 128, value: 'AAEC/w==' }],
      ['uuid', { type: 'binary', subtype: 4, value: 'OyQRAeK7QlWMr0E2xWapYg==' }],
      ['re', { type: 'regex', pattern: 'a\\/b[/]c', flags: 'imsx' }],
      ['reEmpty', { type: 'regex', pattern: '', flags: '' }],
      ['ts', { type: 'timestamp', t: 4_294_967_295, i: 0 }],
      ['min', { type: 'minKey' }],
      ['max', { type: 'maxKey' }],
      ['code', { type: 'code', value: 'f()', scope: doc([['a', int32(1)]]) }],
      [
        'array',
        { type: 'array', items: [doc([]), { type: 'array', items: [] }, { type: 'null' }] },
      ],
      ['dotted.name', { type: 'undefined' }],
      ['', str('empty name')],
    ]),
  ];

  it.each(corpus)('reads back what it writes, on one line and laid out', (value) => {
    expect(sameValue(parseValue(formatValue(value)), value)).toBe(true);
    expect(sameValue(parseValue(formatPretty(value)), value)).toBe(true);
  });
});

describe('ShellReader for statement parsers (V7.5)', () => {
  it('reads identifiers and values one after another', () => {
    const reader = new ShellReader('db.orders.find({ a: 1 })');
    expect(reader.identifier()).toBe('db');
    expect(reader.accept('.')).toBe(true);
    expect(reader.identifier()).toBe('orders');
    reader.expect('.');
    expect(reader.identifier()).toBe('find');
    reader.expect('(');
    expect(reader.value()).toEqual(doc([['a', int32(1)]]));
    reader.expect(')');
    expect(reader.atEnd()).toBe(true);
  });

  it('says what it expected and where', () => {
    const reader = new ShellReader('db x');
    reader.identifier();
    expect(() => {
      reader.expect('.');
    }).toThrow('Expected "." near `x`');
  });
});

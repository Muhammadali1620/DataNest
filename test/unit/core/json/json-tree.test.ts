import { describe, expect, it } from 'vitest';
import {
  formatJson,
  formatJsonLine,
  jsonNumberText,
  jsonString,
  JsonSyntaxError,
  member,
  parseJson,
  parseJsonLines,
  previewJson,
} from '../../../../src/core/json/json-tree';

function errorOf(text: string): JsonSyntaxError {
  try {
    parseJson(text);
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return error;
    }
    throw error;
  }
  throw new Error(`"${text}" parsed`);
}

describe('parseJson (V7.8)', () => {
  it('keeps numbers as the text the server wrote', () => {
    const value = parseJson('{"id": 9007199254740993, "price": 1.10, "e": -2.5E-3, "z": 0}');
    expect(formatJsonLine(value)).toBe('{"id":9007199254740993,"price":1.10,"e":-2.5E-3,"z":0}');
    expect(jsonNumberText(member(value, 'id'))).toBe('9007199254740993');
  });

  it('keeps member order and repeated names', () => {
    const value = parseJson('{"b": 1, "12": 2, "b": 3}');
    expect(value.type === 'object' && value.members.map(([name]) => name)).toEqual([
      'b',
      '12',
      'b',
    ]);
    expect(member(value, 'b')).toEqual({ type: 'number', text: '1' });
  });

  it('reads strings with every escape, and the other values', () => {
    expect(parseJson('"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00"')).toEqual({
      type: 'string',
      value: 'a"b\\c/d\b\f\n\r\té😀',
    });
    expect(parseJson(' [true, false, null, [], {}] ')).toEqual({
      type: 'array',
      items: [
        { type: 'bool', value: true },
        { type: 'bool', value: false },
        { type: 'null' },
        { type: 'array', items: [] },
        { type: 'object', members: [] },
      ],
    });
  });

  it.each([
    ['', 'Expected a value at the end'],
    ['{"a" 1}', 'Expected ":" after the name'],
    ['{a: 1}', 'Expected a name in double quotes'],
    ['[1 2]', 'Expected "," or "]"'],
    ['{"a": 1 "b": 2}', 'Expected "," or "}"'],
    ['"open', 'The string is not closed'],
    ['"a\nb"', 'A control character inside a string'],
    ['"\\x"', 'A wrong escape'],
    ['"\\u12"', 'A wrong \\u escape'],
    ['01', 'Unexpected text after the JSON'],
    ['-', 'Unexpected "-"'],
    ['tru', 'Unexpected "t"'],
    ['{} {}', 'Unexpected text after the JSON'],
    [`${'['.repeat(600)}${']'.repeat(600)}`, 'nests too deeply'],
  ])('refuses %j', (text, message) => {
    expect(errorOf(text).message).toContain(message);
  });

  it('says where it went wrong', () => {
    expect(errorOf('{"a": 1,\n "b" 2}').offset).toBe(14);
  });
});

describe('parseJsonLines (V7.8)', () => {
  it('reads one value per line, skipping blank lines, with their offsets', () => {
    const values = parseJsonLines('{"index":{}}\n\n{"a":1}\n');
    expect(values.map((entry) => entry.offset)).toEqual([0, 14]);
    expect(values.map((entry) => formatJsonLine(entry.value))).toEqual(['{"index":{}}', '{"a":1}']);
  });

  it('says where in the whole text a line is wrong', () => {
    expect(() => parseJsonLines('{"a":1}\n{"b":}')).toThrow(
      expect.objectContaining({ offset: 13 }) as unknown,
    );
  });
});

describe('formatJson (V7.8)', () => {
  it('lays objects out and keeps short plain arrays on one line', () => {
    expect(formatJson(parseJson('{"a":{"b":[1,2]},"c":[],"d":{},"e":[{"f":1}]}'))).toBe(
      '{\n  "a": {\n    "b": [1, 2]\n  },\n  "c": [],\n  "d": {},\n  "e": [\n    {\n      "f": 1\n    }\n  ]\n}',
    );
  });

  it('breaks a long array over lines', () => {
    const long = parseJson(`[${Array.from({ length: 40 }, (_, index) => index).join(',')}]`);
    expect(formatJson(long).split('\n')).toHaveLength(42);
  });
});

describe('helpers (V7.8)', () => {
  it('reads strings and numeric strings, as _cat gives them', () => {
    expect(jsonString(parseJson('"x"'))).toBe('x');
    expect(jsonString(parseJson('1'))).toBeUndefined();
    expect(jsonNumberText(parseJson('"123"'))).toBe('123');
    expect(jsonNumberText(parseJson('"12kb"'))).toBeUndefined();
    expect(jsonNumberText(undefined)).toBeUndefined();
    expect(member(parseJson('[1]'), 'a')).toBeUndefined();
  });

  it('previews a value on one line, cut without splitting a surrogate pair', () => {
    expect(previewJson(parseJson('"a\\nb"'), 10)).toBe('a b');
    expect(previewJson(parseJson('{"a": [1, 2]}'), 20)).toBe('{"a":[1,2]}');
    expect(previewJson(parseJson('"ab😀cd"'), 4)).toBe('ab…');
    expect(previewJson(parseJson('"abcdef"'), 4)).toBe('abc…');
  });
});

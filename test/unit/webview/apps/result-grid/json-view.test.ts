import { describe, expect, it } from 'vitest';
import {
  formatJson,
  isJsonDocument,
  isValidJson,
  minifyJson,
  tokenizeJson,
} from '../../../../../webview/src/apps/result-grid/json-view';

const types = (text: string): string[] =>
  tokenizeJson(text)
    .filter((token) => token.type !== 'space')
    .map((token) => `${token.type}:${token.text}`);

describe('tokenizeJson', () => {
  it('tells keys from string values', () => {
    expect(types('{"a": "b"}')).toEqual(['punct:{', 'key:"a"', 'punct::', 'string:"b"', 'punct:}']);
  });

  it('recognizes numbers, literals and structure', () => {
    expect(types('[1, -2.5e3, true, false, null]')).toEqual([
      'punct:[',
      'number:1',
      'punct:,',
      'number:-2.5e3',
      'punct:,',
      'literal:true',
      'punct:,',
      'literal:false',
      'punct:,',
      'literal:null',
      'punct:]',
    ]);
  });

  it('handles escaped quotes and a colon inside a string', () => {
    expect(types('{"a\\"b:c": "x:y"}')).toEqual([
      'punct:{',
      'key:"a\\"b:c"',
      'punct::',
      'string:"x:y"',
      'punct:}',
    ]);
  });

  it('always covers the whole text, even when it is not JSON', () => {
    for (const text of ['{"a": tru', 'hello world', '"unclosed', '{,,}', '', '  \n ', '\\']) {
      expect(
        tokenizeJson(text)
          .map((token) => token.text)
          .join(''),
      ).toBe(text);
    }
  });

  it('marks what it cannot read as invalid instead of throwing', () => {
    expect(types("{'a': 1}")).toContain("invalid:'a'");
    expect(types('truely')).toEqual(['invalid:truely']);
  });

  it('does not take a literal that is only a prefix of a word', () => {
    expect(types('nullable')).toEqual(['invalid:nullable']);
  });
});

describe('isValidJson / isJsonDocument', () => {
  it('accepts complete values and rejects broken ones', () => {
    expect(isValidJson('{"a":1}')).toBe(true);
    expect(isValidJson('5')).toBe(true);
    expect(isValidJson('{"a":')).toBe(false);
    expect(isValidJson('')).toBe(false);
  });

  it('calls only objects and arrays documents', () => {
    expect(isJsonDocument(' {"a":1} ')).toBe(true);
    expect(isJsonDocument('[1,2]')).toBe(true);
    expect(isJsonDocument('42')).toBe(false);
    expect(isJsonDocument('"text"')).toBe(false);
    expect(isJsonDocument('{oops}')).toBe(false);
  });
});

describe('formatJson', () => {
  it('indents nested structures', () => {
    expect(formatJson('{"a":[1,2,{"b":null}],"c":"d"}')).toBe(
      [
        '{',
        '  "a": [',
        '    1,',
        '    2,',
        '    {',
        '      "b": null',
        '    }',
        '  ],',
        '  "c": "d"',
        '}',
      ].join('\n'),
    );
  });

  it('keeps empty objects and arrays on one line', () => {
    expect(formatJson('{"a":{},"b":[ ]}')).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  it('does not round numbers that a double cannot hold', () => {
    const formatted = formatJson('{"id":12345678901234567890,"p":0.10}');
    expect(formatted).toContain('12345678901234567890');
    expect(formatted).toContain('0.10');
  });

  it('keeps string contents that look like structure untouched', () => {
    expect(formatJson('{"a":"{,}[:]"}')).toBe('{\n  "a": "{,}[:]"\n}');
  });

  it('honours the indent width', () => {
    expect(formatJson('[1]', 4)).toBe('[\n    1\n]');
  });

  it('formats a scalar and re-formats already formatted text the same way', () => {
    expect(formatJson('"x"')).toBe('"x"');
    const once = formatJson('{"a":[1,{"b":2}]}') ?? '';
    expect(formatJson(once)).toBe(once);
  });

  it('returns undefined for invalid JSON', () => {
    expect(formatJson('{"a":')).toBeUndefined();
    expect(formatJson('')).toBeUndefined();
  });
});

describe('minifyJson', () => {
  it('removes whitespace outside strings only', () => {
    expect(minifyJson('{ "a" : "b  c" ,\n "d": [ 1 , 2 ] }')).toBe('{"a":"b  c","d":[1,2]}');
  });

  it('returns undefined for invalid JSON', () => {
    expect(minifyJson('{')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { JsoncError, parseJsonc, stripJsonc } from '../../../src/shared/jsonc';

describe('parseJsonc', () => {
  it('reads plain JSON', () => {
    expect(parseJsonc('{"a": [1, 2, {"b": null}]}')).toEqual({ a: [1, 2, { b: null }] });
  });

  it('ignores line and block comments', () => {
    const text = `{
      // the team's database
      "name": "dev", /* inline */ "port": 5432
      /* a block
         over lines */
    }`;
    expect(parseJsonc(text)).toEqual({ name: 'dev', port: 5432 });
  });

  it('drops trailing commas in objects and arrays, also before a comment', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
    expect(parseJsonc('[1, // last\n]')).toEqual([1]);
  });

  it('keeps comment markers and commas inside strings', () => {
    expect(parseJsonc('{"url": "http://x/*y*/", "s": "a,]", "q": "say \\"//\\","}')).toEqual({
      url: 'http://x/*y*/',
      s: 'a,]',
      q: 'say "//",',
    });
  });

  it('skips a byte order mark', () => {
    expect(parseJsonc('\uFEFF{"a": 1}')).toEqual({ a: 1 });
  });

  it('keeps a comment between tokens from gluing them together', () => {
    expect(stripJsonc('1/**/2')).toBe('1 2');
    expect(() => parseJsonc('1/**/2')).toThrow(JsoncError);
  });

  it('reports broken JSON and an open block comment', () => {
    expect(() => parseJsonc('{"a": }')).toThrow(JsoncError);
    expect(() => parseJsonc('{"a": 1 /* never closed')).toThrow('not closed');
    expect(() => parseJsonc('')).toThrow(JsoncError);
  });

  it('does not treat a lone comma as trailing', () => {
    expect(() => parseJsonc('[,]')).toThrow(JsoncError);
  });

  it('leaves an unterminated string to JSON.parse, which rejects it', () => {
    expect(() => parseJsonc('{"a": "open')).toThrow(JsoncError);
  });
});

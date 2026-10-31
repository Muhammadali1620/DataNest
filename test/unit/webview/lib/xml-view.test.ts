import { describe, expect, it } from 'vitest';
import { looksLikeMarkup, tokenizeXml } from '../../../../webview/src/lib/xml-view';

const kinds = (text: string): [string, string][] =>
  tokenizeXml(text)
    .filter((token) => token.type !== 'text' || token.text.trim() !== '')
    .map((token) => [token.type, token.text]);

describe('tokenizeXml', () => {
  it('colours tag names, attributes and values apart', () => {
    expect(kinds('<rect width="10" fill=\'red\'/>')).toEqual([
      ['punct', '<'],
      ['tag', 'rect'],
      ['attr', 'width'],
      ['punct', '='],
      ['string', '"10"'],
      ['attr', 'fill'],
      ['punct', '='],
      ['string', "'red'"],
      ['punct', '/>'],
    ]);
  });

  it('handles closing tags, text and nesting', () => {
    expect(kinds('<a>hi</a>')).toEqual([
      ['punct', '<'],
      ['tag', 'a'],
      ['punct', '>'],
      ['text', 'hi'],
      ['punct', '</'],
      ['tag', 'a'],
      ['punct', '>'],
    ]);
  });

  it('keeps comments, declarations and processing instructions whole', () => {
    expect(kinds('<?xml version="1.0"?><!-- a <b> -->')).toEqual([
      ['decl', '<?xml version="1.0"?>'],
      ['comment', '<!-- a <b> -->'],
    ]);
    expect(kinds('<!DOCTYPE svg>')).toEqual([['decl', '<!DOCTYPE svg>']]);
  });

  it('copes with namespaced names and attributes', () => {
    expect(kinds('<svg:g xlink:href="#a">')[1]).toEqual(['tag', 'svg:g']);
    expect(kinds('<svg:g xlink:href="#a">')[2]).toEqual(['attr', 'xlink:href']);
  });

  it('colours half-typed markup without failing', () => {
    expect(kinds('<a href="x')).toEqual([
      ['punct', '<'],
      ['tag', 'a'],
      ['attr', 'href'],
      ['punct', '='],
      ['string', '"x'],
    ]);
    expect(kinds('<!-- never closed')).toEqual([['comment', '<!-- never closed']]);
    expect(kinds('<a <b>').map(([type]) => type)).toContain('tag');
  });

  it('treats a lone "<" as text', () => {
    expect(
      tokenizeXml('1 < 2')
        .map((token) => token.text)
        .join(''),
    ).toBe('1 < 2');
  });

  it.each(['', '<', '<>', '</', '<a b', '"', '<a "x" =>', '<!-', '<a\n\tb="1"\n/>'])(
    'always gives back the whole text for %j',
    (text) => {
      expect(
        tokenizeXml(text)
          .map((token) => token.text)
          .join(''),
      ).toBe(text);
    },
  );
});

describe('looksLikeMarkup', () => {
  it.each(['<svg/>', '  <a>', '<?xml?>', '<!-- x -->', '</a>'])('knows %j', (text) => {
    expect(looksLikeMarkup(text)).toBe(true);
  });

  it.each(['', 'text', '1 < 2', '{"a":"<b>"}', '< a'])('refuses %j', (text) => {
    expect(looksLikeMarkup(text)).toBe(false);
  });
});

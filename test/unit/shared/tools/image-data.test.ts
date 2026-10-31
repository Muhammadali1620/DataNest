import { describe, expect, it } from 'vitest';
import {
  cssUrl,
  extensionOfFormat,
  formatSvg,
  htmlImg,
  isSvg,
  MAX_IMAGE_SIDE,
  mimeOf,
  parseDataUrl,
  resizeTo,
  setRootFill,
  svgToDataUrl,
} from '../../../../src/shared/tools/image-data';

describe('data URLs', () => {
  it('splits a base64 data URL', () => {
    expect(parseDataUrl('data:image/png;base64,iVBORw0=')).toEqual({
      mime: 'image/png',
      base64: 'iVBORw0=',
    });
    expect(parseDataUrl('data:image/svg+xml;charset=utf-8;base64,PHN2Zz4=')?.mime).toBe(
      'image/svg+xml',
    );
  });

  it.each(['', 'data:text/plain,hello', 'http://x/y.png', 'data:image/png;base64,***'])(
    'refuses %j',
    (text) => {
      expect(parseDataUrl(text)).toBeUndefined();
    },
  );

  it('wraps for CSS and HTML, escaping quotes', () => {
    expect(cssUrl('data:image/png;base64,AAAA')).toBe('url("data:image/png;base64,AAAA")');
    expect(cssUrl('a"b')).toBe('url("a%22b")');
    expect(htmlImg('data:x', 10, 20)).toBe('<img src="data:x" width="10" height="20" alt="">');
    expect(htmlImg('data:x')).toBe('<img src="data:x" alt="">');
    expect(htmlImg('a"b')).toContain('a&quot;b');
  });
});

describe('resizeTo', () => {
  const original = { width: 200, height: 100 };

  it('keeps the ratio when asked', () => {
    expect(resizeTo(original, 'width', 100, true)).toEqual({ width: 100, height: 50 });
    expect(resizeTo(original, 'height', 300, true)).toEqual({ width: 600, height: 300 });
  });

  it('changes one side only otherwise', () => {
    expect(resizeTo(original, 'width', 50, false)).toEqual({ width: 50, height: 100 });
    expect(resizeTo(original, 'height', 50, false)).toEqual({ width: 200, height: 50 });
  });

  it('rounds and clamps to whole pixels in range', () => {
    expect(resizeTo(original, 'width', 0, false).width).toBe(1);
    expect(resizeTo(original, 'width', 1e9, false).width).toBe(MAX_IMAGE_SIDE);
    expect(resizeTo(original, 'width', 33, true).height).toBe(17);
    expect(resizeTo({ width: 1000, height: 1 }, 'width', 1, true)).toEqual({ width: 1, height: 1 });
  });

  it('leaves the size alone for nonsense', () => {
    expect(resizeTo(original, 'width', Number.NaN, true)).toBe(original);
    expect(resizeTo({ width: 0, height: 0 }, 'width', 5, true)).toEqual({ width: 0, height: 0 });
  });
});

describe('formats', () => {
  it('names mime types and extensions', () => {
    expect(mimeOf('jpeg')).toBe('image/jpeg');
    expect(extensionOfFormat('jpeg')).toBe('jpg');
    expect(extensionOfFormat('webp')).toBe('webp');
  });
});

describe('svg', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>';

  it('recognises an SVG, with a prolog or comments first', () => {
    expect(isSvg(svg)).toBe(true);
    expect(isSvg(`<?xml version="1.0"?>\n<!-- hi -->\n${svg}`)).toBe(true);
    expect(isSvg('<html></html>')).toBe(false);
    expect(isSvg('')).toBe(false);
  });

  it('makes a data URL that decodes to the same text', () => {
    const url = svgToDataUrl(`${svg}é`);
    const parts = parseDataUrl(url);
    expect(parts?.mime).toBe('image/svg+xml');
    expect(Buffer.from(parts?.base64 ?? '', 'base64').toString('utf8')).toBe(`${svg}é`);
  });

  it('indents by tags', () => {
    expect(formatSvg(svg)).toBe(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">',
        '  <rect width="5" height="5"/>',
        '</svg>',
      ].join('\n'),
    );
  });

  it('formats nested elements and keeps short text on its line', () => {
    expect(formatSvg('<svg><g><text>Hi</text><circle r="1"/></g></svg>')).toBe(
      ['<svg>', '  <g>', '    <text>Hi</text>', '    <circle r="1"/>', '  </g>', '</svg>'].join(
        '\n',
      ),
    );
  });

  it('is stable when formatted twice, and refuses what is not an SVG', () => {
    const once = formatSvg(svg) ?? '';
    expect(formatSvg(once)).toBe(once);
    expect(formatSvg('<div></div>')).toBeUndefined();
  });

  it('sets the fill on the root element only', () => {
    expect(setRootFill(svg, '#ff0000')).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="#ff0000">',
    );
    expect(setRootFill(svg, '#ff0000')).toContain('<rect width="5" height="5"/>');
    expect(setRootFill('<svg fill="blue" width="1">', 'red')).toBe('<svg width="1" fill="red">');
  });

  it('refuses a fill that could carry markup, and text that is not an SVG', () => {
    expect(setRootFill(svg, '"><script>')).toBeUndefined();
    expect(setRootFill('<div>', '#fff')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  derive,
  hslToRgb,
  luminance,
  mix,
  parseHex,
  parseRgb,
  rgbToHsl,
  shift,
  textOn,
  toHex,
  toRgbString,
} from '../../../../src/shared/tools/colors';

describe('hex', () => {
  it('parses six and three digits, with or without #', () => {
    expect(parseHex('#3478C6')).toEqual({ r: 52, g: 120, b: 198 });
    expect(parseHex('3478c6')).toEqual({ r: 52, g: 120, b: 198 });
    expect(parseHex('#fa0')).toEqual({ r: 255, g: 170, b: 0 });
    expect(parseHex('  #FFF ')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it.each(['', '#12', '#12345', '#1234567', 'xyzxyz', '#gg0000'])('refuses %j', (text) => {
    expect(parseHex(text)).toBeUndefined();
  });

  it('formats upper case and clamps channels', () => {
    expect(toHex({ r: 52, g: 120, b: 198 })).toBe('#3478C6');
    expect(toHex({ r: -5, g: 300, b: 0.4 })).toBe('#00FF00');
  });
});

describe('rgb', () => {
  it('parses the usual spellings', () => {
    expect(parseRgb('rgb(52, 120, 198)')).toEqual({ r: 52, g: 120, b: 198 });
    expect(parseRgb('52,120,198')).toEqual({ r: 52, g: 120, b: 198 });
    expect(parseRgb('52 120 198')).toEqual({ r: 52, g: 120, b: 198 });
  });

  it('refuses channels above 255 and incomplete text', () => {
    expect(parseRgb('256, 0, 0')).toBeUndefined();
    expect(parseRgb('1, 2')).toBeUndefined();
    expect(parseRgb('rgb(1,2,3,4)')).toBeUndefined();
    expect(parseRgb('')).toBeUndefined();
  });

  it('formats', () => {
    expect(toRgbString({ r: 1, g: 2, b: 3 })).toBe('rgb(1, 2, 3)');
  });
});

describe('hsl', () => {
  it('converts the primaries', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 255, b: 0 }).h).toBe(120);
    expect(rgbToHsl({ r: 0, g: 0, b: 255 }).h).toBe(240);
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toMatchObject({ h: 0, s: 0 });
  });

  it('round-trips within a unit', () => {
    for (const color of [
      { r: 52, g: 120, b: 198 },
      { r: 229, g: 72, b: 77 },
      { r: 10, g: 200, b: 90 },
    ]) {
      const back = hslToRgb(rgbToHsl(color));
      expect(Math.abs(back.r - color.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - color.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - color.b)).toBeLessThanOrEqual(1);
    }
  });

  it('wraps hue and clamps saturation and lightness', () => {
    expect(hslToRgb({ h: 360, s: 100, l: 50 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hslToRgb({ h: -120, s: 100, l: 50 })).toEqual({ r: 0, g: 0, b: 255 });
    expect(hslToRgb({ h: 0, s: 500, l: 200 })).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('shifts lightness and stops at the ends', () => {
    expect(rgbToHsl(shift({ r: 52, g: 120, b: 198 }, 10)).l).toBeGreaterThan(
      rgbToHsl({ r: 52, g: 120, b: 198 }).l,
    );
    expect(shift({ r: 250, g: 250, b: 250 }, 50)).toEqual({ r: 255, g: 255, b: 255 });
    expect(shift({ r: 5, g: 5, b: 5 }, -50)).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('mix', () => {
  it('goes from one colour to the other', () => {
    const [a, b] = [
      { r: 0, g: 0, b: 0 },
      { r: 200, g: 100, b: 50 },
    ];
    expect(mix(a, b, 0)).toEqual(a);
    expect(mix(a, b, 1)).toEqual(b);
    expect(mix(a, b, 0.5)).toEqual({ r: 100, g: 50, b: 25 });
    expect(mix(a, b, 2)).toEqual(b);
    expect(mix(a, b, -1)).toEqual(a);
  });
});

describe('contrast', () => {
  it('knows black and white', () => {
    expect(luminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 3);
    expect(contrastRatio({ r: 9, g: 9, b: 9 }, { r: 9, g: 9, b: 9 })).toBe(1);
  });

  it('puts white text on dark colours and black text on light ones', () => {
    expect(textOn({ r: 20, g: 40, b: 120 })).toEqual({ r: 255, g: 255, b: 255 });
    expect(textOn({ r: 250, g: 220, b: 90 })).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('derive', () => {
  it('gives darker hover and active, a lighter light, and tints toward the page', () => {
    const base = { r: 30, g: 70, b: 150 };
    const d = derive(base);
    const l = (c: typeof base): number => rgbToHsl(c).l;
    expect(l(d.hover)).toBeLessThan(l(base));
    expect(l(d.active)).toBeLessThan(l(d.hover));
    expect(l(d.light)).toBeGreaterThan(l(base));
    expect(d.textOnColor).toEqual({ r: 255, g: 255, b: 255 });
    expect(toHex(d.softBackground)).toBe(toHex(mix({ r: 31, g: 31, b: 31 }, base, 0.12)));
    expect(l(d.softHover)).toBeGreaterThan(l(d.softBackground));
    expect(l(d.border)).toBeGreaterThan(l(d.softHover));
  });

  it('tints toward another page colour', () => {
    expect(
      derive({ r: 255, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }).softBackground.g,
    ).toBeGreaterThan(200);
  });
});

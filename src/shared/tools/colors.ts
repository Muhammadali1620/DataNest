// Colour maths of the Tools page: parsing, conversion and the shades derived from one colour.

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Hsl {
  /** 0–360. */
  readonly h: number;
  /** 0–100. */
  readonly s: number;
  /** 0–100. */
  readonly l: number;
}

const clampByte = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

/** `#abc`, `abc`, `#aabbcc` or `aabbcc`; anything else is undefined. */
export function parseHex(text: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(text.trim());
  const digits = match?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const full = digits.length === 3 ? Array.from(digits, (digit) => digit + digit).join('') : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function toHex(color: Rgb): string {
  const part = (value: number): string => clampByte(value).toString(16).padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase();
}

/** `rgb(1, 2, 3)` or `1, 2, 3` or `1 2 3`; each channel 0–255. */
export function parseRgb(text: string): Rgb | undefined {
  const match = /^(?:rgb\()?\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/iu.exec(
    text.trim(),
  );
  if (match === null) {
    return undefined;
  }
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => Number(part));
  if ([r, g, b].some((value) => value === undefined || value > 255)) {
    return undefined;
  }
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}

export function toRgbString(color: Rgb): string {
  return `rgb(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)})`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return { h: 0, s: 0, l: l * 100 };
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) {
    h = ((gn - bn) / d) % 6;
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = ln - c / 2;
  return {
    r: clampByte((r1 + m) * 255),
    g: clampByte((g1 + m) * 255),
    b: clampByte((b1 + m) * 255),
  };
}

/** Moves the lightness by `delta` points (negative darkens), keeping hue and saturation. */
export function shift(color: Rgb, delta: number): Rgb {
  const hsl = rgbToHsl(color);
  return hslToRgb({ ...hsl, l: Math.min(100, Math.max(0, hsl.l + delta)) });
}

/** `amount` 0 is `from`, 1 is `to`. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount));
  return {
    r: clampByte(from.r + (to.r - from.r) * t),
    g: clampByte(from.g + (to.g - from.g) * t),
    b: clampByte(from.b + (to.b - from.b) * t),
  };
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** White or black, whichever reads better on the colour. */
export function textOn(color: Rgb): Rgb {
  return contrastRatio(color, WHITE) >= contrastRatio(color, BLACK) ? WHITE : BLACK;
}

export interface DerivedColors {
  readonly hover: Rgb;
  readonly active: Rgb;
  readonly light: Rgb;
  readonly textOnColor: Rgb;
  readonly softBackground: Rgb;
  readonly softHover: Rgb;
  readonly border: Rgb;
}

/** The shades a button, a tag or a tint needs, all from one colour on a dark page. */
export function derive(color: Rgb, page: Rgb = { r: 31, g: 31, b: 31 }): DerivedColors {
  return {
    hover: shift(color, -8),
    active: shift(color, -14),
    light: shift(color, 14),
    textOnColor: textOn(color),
    softBackground: mix(page, color, 0.12),
    softHover: mix(page, color, 0.2),
    border: mix(page, color, 0.5),
  };
}

export const SWATCHES: readonly string[] = [
  '#3478C6',
  '#2EB872',
  '#E5484D',
  '#F5A524',
  '#9B6BD6',
  '#13B5CC',
  '#E5612A',
  '#7C8DF0',
  '#5C9A1F',
  '#F2C200',
];
